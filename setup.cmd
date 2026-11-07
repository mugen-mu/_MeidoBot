@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo  Meido: установка бота (около 5 минут, потребуется ваш вход в Cloudflare)
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo  Не найден Node.js. Скачайте его с https://nodejs.org ^(зелёная кнопка LTS^),
  echo  установите и запустите этот файл ещё раз.
  pause
  exit /b 1
)
call npm install --no-audit --no-fund
if errorlevel 1 (
  echo  Не удалось установить зависимости. Проверьте интернет и запустите файл ещё раз.
  pause
  exit /b 1
)
call npm run setup
echo.
pause
