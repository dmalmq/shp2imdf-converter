$backend = Start-Process pwsh -ArgumentList "-NoExit", "-Command", "uvicorn backend.main:app --reload --port 8310" -PassThru
$frontend = Start-Process pwsh -ArgumentList "-NoExit", "-Command", "cd frontend; npm run dev" -PassThru

Write-Host "Backend PID: $($backend.Id)  |  Frontend PID: $($frontend.Id)"
Write-Host "Press Ctrl+C to stop both..."

try {
    Wait-Process -Id $backend.Id, $frontend.Id
} finally {
    Stop-Process -Id $backend.Id, $frontend.Id -ErrorAction SilentlyContinue
}
