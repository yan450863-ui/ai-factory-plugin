$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$marketplaceRoot = Join-Path $projectRoot '插件市场'
$buildScript = Join-Path $PSScriptRoot 'build.mjs'
$codexBin = (Get-Command codex -ErrorAction Stop).Source
$nodeBin = (Get-Command node -ErrorAction Stop).Source

$requiredDependencies = @(
  (Join-Path $PSScriptRoot 'node_modules\esbuild\package.json'),
  (Join-Path $PSScriptRoot 'node_modules\happy-dom\package.json'),
  (Join-Path $PSScriptRoot 'node_modules\smol-toml\package.json'),
  (Join-Path $PSScriptRoot 'node_modules\@modelcontextprotocol\sdk\package.json')
)
if ($requiredDependencies | Where-Object { -not (Test-Path -LiteralPath $_ -PathType Leaf) }) {
  $npmBin = (Get-Command npm -ErrorAction Stop).Source
  Push-Location $PSScriptRoot
  try {
    & $npmBin ci
    if ($LASTEXITCODE -ne 0) { throw 'AI工厂插件依赖安装失败；请检查 npm 和 package-lock.json' }
  } finally {
    Pop-Location
  }
}

& $nodeBin $buildScript
if ($LASTEXITCODE -ne 0) { throw 'Codex Factory 构建失败' }

& $codexBin plugin marketplace add $marketplaceRoot --json
if ($LASTEXITCODE -ne 0) { throw '注册 Codex Factory 本地市场失败；未修改其他市场或插件' }

& $codexBin plugin add 'codex-factory@ai-factory-plugin' --json
if ($LASTEXITCODE -ne 0) { throw '安装 Codex Factory 插件失败；未修改其他插件' }

Write-Output 'AI工厂插件已安装或原位升级。请在“插件 → AI工厂插件 → 打开插件”中查看，无需重启 Codex 进程。'
