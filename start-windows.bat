@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js 22.13 이상을 먼저 설치해 주세요: https://nodejs.org & pause & exit /b 1)
if not exist node_modules (
  echo 의존성을 설치합니다...
  call npm install || (pause & exit /b 1)
)
echo 웹 화면을 빌드합니다...
call npm run build || (pause & exit /b 1)
echo.
echo CoinSignal 을 시작합니다. 브라우저에서 http://127.0.0.1:8787 로 접속하세요.
echo 이 창을 닫으면 자동 운용도 멈춥니다.
call npm start
pause
