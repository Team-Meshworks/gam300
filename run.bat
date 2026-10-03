@echo off
setlocal
cd /d "%~dp0"
where git >nul 2>&1
if errorlevel 1 (echo Setup failed: Install Git and Git LFS; see README.md. & exit /b 1)
call git lfs version >nul 2>&1
if errorlevel 1 (echo Setup failed: Install Git LFS; see README.md. & exit /b 1)
where docker >nul 2>&1
if errorlevel 1 (echo Setup failed: Install and start Docker; see README.md. & exit /b 1)
call docker compose version >nul 2>&1
if errorlevel 1 (echo Setup failed: Docker Compose is required; see README.md. & exit /b 1)
docker info --format "{{.OSType}}" 2>nul | findstr /x linux >nul
if errorlevel 1 (echo Setup failed: Start Docker with Linux containers and allow access. & exit /b 1)
docker compose up --help | findstr /c:"--wait" >nul
if errorlevel 1 (echo Setup failed: Update Docker Compose to a version supporting --wait. & exit /b 1)
if not defined COMPOSE_PROJECT_NAME set "COMPOSE_PROJECT_NAME=spatia-local"
if not defined APP_PORT set "APP_PORT=8081"
if not defined BUILD_MODE set "BUILD_MODE=development"
if not "%BUILD_MODE%"=="development" if not "%BUILD_MODE%"=="production" (echo Setup failed: BUILD_MODE must be development ^(M1^) or production. & exit /b 1)
if not defined REVISION for /f "delims=" %%i in ('git rev-parse HEAD') do set "REVISION=%%i"
if not defined REVISION (echo Setup failed: Run from a Git checkout with a commit. & exit /b 1)

echo Restoring the locked 3D assets...
call git lfs pull --include="assets/delivery/**,web/editor/public/models/**" --exclude=""
if errorlevel 1 (echo Setup failed: Git LFS download failed. Check repository access and your network. & exit /b 1)
echo Installing locked packages, checking, building and testing ^(%BUILD_MODE%, %REVISION%^) ...
call docker compose --project-name "%COMPOSE_PROJECT_NAME%" up --build --wait --wait-timeout 120
if errorlevel 1 (echo Setup failed: Build, tests or startup failed. Read the error above. & exit /b 1)
echo Spatia is ready at http://localhost:%APP_PORT%/
echo Stop it with: docker compose --project-name %COMPOSE_PROJECT_NAME% down
