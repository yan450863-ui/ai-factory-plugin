param(
  [switch]$KeepMarketplace
)

$ErrorActionPreference = 'Stop'

$codexBin = (Get-Command codex -ErrorAction Stop).Source
$nodeBin = (Get-Command node -ErrorAction Stop).Source
$cli = Join-Path $PSScriptRoot 'factory-cli.mjs'
$factoryDataDir = if ($env:CODEX_FACTORY_DATA_DIR) {
  $env:CODEX_FACTORY_DATA_DIR
} elseif ($env:LOCALAPPDATA) {
  Join-Path $env:LOCALAPPDATA 'CodexFactory'
} else {
  Join-Path $env:USERPROFILE '.codex-factory'
}

$nativeState = Join-Path $factoryDataDir 'models\native-limit.json'
if (Test-Path -LiteralPath $nativeState -PathType Leaf) {
  & $nodeBin $cli models-restore-native --data-dir $factoryDataDir
  if ($LASTEXITCODE -ne 0) {
    throw '恢复 Codex 原生并发原值失败；未卸载插件，未删除数据。'
  }
}

& $codexBin plugin remove 'codex-factory@ai-factory-plugin' --json
if ($LASTEXITCODE -ne 0) { throw '卸载 Codex Factory 插件失败；未删除任何项目数据' }

if (-not $KeepMarketplace) {
  & $codexBin plugin marketplace remove 'ai-factory-plugin' --json
  if ($LASTEXITCODE -ne 0) {
    Write-Warning '插件已卸载，但 Codex Factory 本地市场未移除。其他市场与插件未被改动。'
  }
}

Write-Output 'AI工厂插件已卸载。项目源码、验证记录和插件数据目录均已保留。'
