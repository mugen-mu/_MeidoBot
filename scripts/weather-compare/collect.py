"""Сравнение прогнозов погоды для Днепра (решение D3: выбрать поставщика по 2 неделям).

Раз в сутки (задача планировщика «Meido Weather Compare»):
  python collect.py            - сохранить прогноз на ЗАВТРА от каждого источника и дописать «факт» за прошедшие дни
  python collect.py report     - таблица: средняя ошибка каждого источника (после нескольких дней сбора)

Только стандартная библиотека. Данные - рядом, в data/weather-compare/ (в git не попадают).
Факт = уточнённые данные Open-Meteo за прошедшие дни (расчёт по станциям и спутникам, не термометр во дворе):
летных METAR по Днепру сейчас нет. Для честного сравнения источников этого достаточно.
"""
import csv
import json
import sys
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

LAT, LON = 48.4647, 35.0462
ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data" / "weather-compare"
FORECASTS = DATA / "forecasts.csv"
ACTUALS = DATA / "actuals.csv"
VARS = ["tmax", "tmin", "precip", "wind"]
UA = "MeidoWeatherComparison/1.0 (personal use; github.com/mugen-mu)"
OM_MODELS = ["best_match", "ecmwf_ifs025", "icon_seamless", "gfs_seamless"]


def get_json(url: str):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def om_url(extra: str) -> str:
    return (
        "https://api.open-meteo.com/v1/forecast?latitude=%s&longitude=%s&timezone=Europe%%2FKyiv"
        "&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max%s" % (LAT, LON, extra)
    )


def open_meteo(target: str):
    """Четыре прогноза за один запрос: основная модель и три отдельные."""
    j = get_json(om_url("&forecast_days=3&models=" + ",".join(OM_MODELS)))
    days = j["daily"]["time"]
    if target not in days:
        return [], j.get("utc_offset_seconds", 7200)
    i = days.index(target)
    rows = []
    for m in OM_MODELS:
        s = "_" + m
        rows.append((
            "om:" + m,
            j["daily"]["temperature_2m_max" + s][i], j["daily"]["temperature_2m_min" + s][i],
            j["daily"]["precipitation_sum" + s][i], j["daily"]["wind_speed_10m_max" + s][i],
        ))
    return rows, j.get("utc_offset_seconds", 7200)


def met_no(target: str, utc_offset: int):
    j = get_json("https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=%.2f&lon=%.2f" % (LAT, LON))
    temps, wind, precip = [], [], 0.0
    got_precip = False
    for t in j["properties"]["timeseries"]:
        local = datetime.fromisoformat(t["time"].replace("Z", "+00:00")) + timedelta(seconds=utc_offset)
        if local.date().isoformat() != target:
            continue
        d = t["data"]
        temps.append(d["instant"]["details"]["air_temperature"])
        wind.append(d["instant"]["details"]["wind_speed"] * 3.6)
        n1 = d.get("next_1_hours")
        if n1:
            precip += n1["details"].get("precipitation_amount", 0.0)
            got_precip = True
    if not temps:
        return []
    if not got_precip:  # дальше суток данные по 6 часов
        for t in j["properties"]["timeseries"]:
            local = datetime.fromisoformat(t["time"].replace("Z", "+00:00")) + timedelta(seconds=utc_offset)
            n6 = t["data"].get("next_6_hours")
            if n6 and local.date().isoformat() == target and local.hour % 6 == 0:
                precip += n6["details"].get("precipitation_amount", 0.0)
    return [("metno", max(temps), min(temps), round(precip, 1), round(max(wind), 1))]


def wttr(target: str):
    j = get_json("https://wttr.in/Dnipro?format=j1")
    for w in j["weather"]:
        if w["date"] == target:
            return [("wttr", float(w["maxtempC"]), float(w["mintempC"]),
                     round(sum(float(h["precipMM"]) for h in w["hourly"]), 1),
                     max(float(h["windspeedKmph"]) for h in w["hourly"]))]
    return []


def actuals():
    """Факт за последние дни (анализ Open-Meteo): date -> (tmax, tmin, precip, wind)."""
    j = get_json(om_url("&past_days=4&forecast_days=1"))
    d = j["daily"]
    out = {}
    for i, day in enumerate(d["time"]):
        vals = (d["temperature_2m_max"][i], d["temperature_2m_min"][i], d["precipitation_sum"][i], d["wind_speed_10m_max"][i])
        if all(v is not None for v in vals):
            out[day] = vals
    return out


def read(path: Path):
    if not path.exists():
        return []
    with path.open(encoding="utf-8", newline="") as f:
        return list(csv.DictReader(f))


def write(path: Path, fields, rows):
    with path.open("w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(fields)
        w.writerows(rows)


def collect():
    DATA.mkdir(parents=True, exist_ok=True)
    today = datetime.now(timezone.utc).astimezone().date()  # местное время ПК (Киев)
    target = (today + timedelta(days=1)).isoformat()
    existing = {(r["target"], r["source"]) for r in read(FORECASTS)}
    new, errors = [], []
    offset = 7200
    for name, fn in (("open-meteo", lambda: open_meteo(target)), ("met.no", None), ("wttr", lambda: wttr(target))):
        try:
            if name == "open-meteo":
                rows, offset = fn()
            elif name == "met.no":
                rows = met_no(target, offset)
            else:
                rows = fn()
        except Exception as e:  # один сбой источника не должен ронять остальных
            errors.append("%s: %s" % (name, e))
            continue
        for src, tmax, tmin, precip, wind in rows:
            if (target, src) not in existing:
                new.append([today.isoformat(), target, src, tmax, tmin, precip, wind])
    if new:
        with FORECASTS.open("a", encoding="utf-8", newline="") as f:
            w = csv.writer(f)
            if FORECASTS.stat().st_size == 0 if FORECASTS.exists() else True:
                w.writerow(["fetched", "target", "source", "tmax", "tmin", "precip", "wind"])
            w.writerows(new)
    try:
        act = actuals()
        old = {r["date"]: [r[v] for v in VARS] for r in read(ACTUALS)}
        old.update({k: list(v) for k, v in act.items()})
        write(ACTUALS, ["date"] + VARS, [[k] + v for k, v in sorted(old.items())])
    except Exception as e:
        errors.append("actuals: %s" % e)
    print("прогнозов добавлено: %d (на %s); ошибки: %s" % (len(new), target, "; ".join(errors) or "нет"))


def report():
    act = {r["date"]: {v: float(r[v]) for v in VARS} for r in read(ACTUALS)}
    per = {}
    for r in read(FORECASTS):
        a = act.get(r["target"])
        if not a:
            continue
        st = per.setdefault(r["source"], {"n": 0, "err": {v: 0.0 for v in VARS}, "rain_ok": 0})
        st["n"] += 1
        for v in VARS:
            st["err"][v] += abs(float(r[v]) - a[v])
        st["rain_ok"] += (float(r["precip"]) >= 1.0) == (a["precip"] >= 1.0)
    if not per:
        print("пока нечего сравнивать: нужны дни, для которых уже есть и прогноз, и факт")
        return
    print("%-22s %4s  %8s %8s %10s %9s  %s" % ("источник", "дней", "tmax ±°C", "tmin ±°C", "осадки ±мм", "ветер ±км/ч", "дождь да/нет угадан"))
    ranked = sorted(per.items(), key=lambda kv: (kv[1]["err"]["tmax"] + kv[1]["err"]["tmin"]) / kv[1]["n"])
    for src, st in ranked:
        n = st["n"]
        print("%-22s %4d  %8.1f %8.1f %10.1f %9.1f  %d из %d" % (
            src, n, st["err"]["tmax"] / n, st["err"]["tmin"] / n, st["err"]["precip"] / n, st["err"]["wind"] / n, st["rain_ok"], n))


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    report() if len(sys.argv) > 1 and sys.argv[1] == "report" else collect()
