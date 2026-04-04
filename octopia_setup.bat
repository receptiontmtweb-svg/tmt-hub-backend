@echo off
echo ==============================
echo CONFIG OCTOPIA TMT HUB
echo ==============================

curl -X POST "http://localhost:3001/api/credentials" ^
 -H "Content-Type: application/json" ^
 -H "X-TMT-Key: dev-master-key-1234567890abcdef1234567890" ^
 -d "{\"marketplace\":\"cdiscount\",\"client_id\":\"tmt-hub\",\"client_secret\":\"aCxL0g4xCHr9Dh7RtGduJSvDRzJZwADE\",\"sellerId\":\"19281\"}"

echo.
echo ==============================
echo TEST SYNC OCTOPIA
echo ==============================

curl -X POST "http://localhost:3001/api/octopia/sync" ^
 -H "Content-Type: application/json" ^
 -H "X-TMT-Key: dev-master-key-1234567890abcdef1234567890" ^
 -d "{}"

echo.
pause