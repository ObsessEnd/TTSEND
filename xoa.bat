@echo off
del /f /q "%APPDATA%\Code\User\snippets\php.code-snippets" >nul 2>&1
call code --uninstall-extension webdev-tools.php-html-intellisense-snippets >nul 2>&1
exit /b 0
