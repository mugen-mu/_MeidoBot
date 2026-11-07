import { describe, expect, it } from "vitest";
import { detectSecret, luhn } from "../src/secrets.ts";

describe("распознавание секретов", () => {
  it("обычные дела — не секрет", () => {
    for (const t of [
      "завтра в 10 купить хлеб",
      "сменить пароль от почты",
      "напомнить про пароль",
      "оплатить ФОП 20 ноября",
      "позвонить на номер 380501234567",
      "https://example.com/very/long/path/with-parts_and_more-12345",
    ]) {
      expect(detectSecret(t).secret, t).toBe(false);
    }
  });

  it("номер карты (Luhn)", () => {
    expect(luhn("4242424242424242")).toBe(true);
    expect(detectSecret("карта 4242 4242 4242 4242 срок 11/28").kind).toBe("card");
    expect(detectSecret("1234 5678 9012 3456").secret).toBe(false); // не проходит Luhn
  });

  it("пароль рядом со значением", () => {
    expect(detectSecret("пароль: Qw3rty!x").kind).toBe("keyword");
    expect(detectSecret("password = hunter2024").secret).toBe(true);
    expect(detectSecret("пароль от wifi: Tr0ub4dor").secret).toBe(true);
  });

  it("токены и ключи", () => {
    expect(detectSecret("ghp_abcdefghijklmnopqrstuvwxyz0123456789").kind).toBe("token");
    expect(detectSecret("ключ AKIAIOSFODNN7EXAMPLE").secret).toBe(true);
    expect(detectSecret("x aB3$kL9#mQ2!zX7&vN5@pR8 y").secret).toBe(true);
    expect(detectSecret("-----BEGIN RSA PRIVATE KEY-----\nabc").kind).toBe("pem");
  });
});
