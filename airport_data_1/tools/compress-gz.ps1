# compress-gz.ps1 —— 将 JS/文本文件压缩为 "*.gz.js"（内嵌 base64 的 gzip 数据）
# 配合 js/gzip-loader.js 使用：GzipLoader.exec(window.__GZ_B64__)
# 用法：
#   .\compress-gz.ps1 -InFile "js\airports_filtered.js"
#   .\compress-gz.ps1 -InFile "xxx.js" -OutFile "yyy.js.gz.js" -VarName "__GZ_B64__"
param(
    [Parameter(Mandatory = $true)][string]$InFile,
    [string]$OutFile = "",
    [string]$VarName = "__GZ_B64__"
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path $InFile)) { Write-Error "找不到输入文件: $InFile"; exit 1 }
if ($VarName -notmatch '^[$_][$_A-Za-z0-9]*$') { Write-Error "变量名不合法: $VarName"; exit 1 }
if (-not $OutFile) { $OutFile = "$InFile.gz.js" }

# 1. 读取并 gzip 压缩
$bytes = [IO.File]::ReadAllBytes($InFile)
$ms = New-Object IO.MemoryStream
$gz = New-Object IO.Compression.GZipStream($ms, [IO.Compression.CompressionLevel]::Optimal, $true)
$gz.Write($bytes, 0, $bytes.Length)
$gz.Dispose()
$gzBytes = $ms.ToArray()
$ms.Dispose()

# 2. base64 + 生成 wrapper js（每行 4096 字符，编辑器友好）
$b64 = [Convert]::ToBase64String($gzBytes)
$sb = New-Object Text.StringBuilder
[void]$sb.AppendLine("/* gzip-wrapper v1 | 原始文件: $(Split-Path $InFile -Leaf) | 原始: $($bytes.Length) B | gzip: $($gzBytes.Length) B | 由 compress-gz.ps1 生成 | 配合 gzip-loader.js 使用: GzipLoader.exec(window.$VarName) */")
[void]$sb.AppendLine("window.$VarName = [")
$CHUNK = 4096
for ($i = 0; $i -lt $b64.Length; $i += $CHUNK) {
    $len = [Math]::Min($CHUNK, $b64.Length - $i)
    [void]$sb.AppendLine('"' + $b64.Substring($i, $len) + '",')
}
[void]$sb.AppendLine('].join("");')
$wrapper = $sb.ToString()
[IO.File]::WriteAllText($OutFile, $wrapper)   # UTF-8 无 BOM

# 3. 自校验：内存中解压 gzip 并与原文件比对 SHA256
$ms2 = New-Object IO.MemoryStream(,$gzBytes)
$gz2 = New-Object IO.Compression.GZipStream($ms2, [IO.Compression.CompressionMode]::Decompress)
$outMs = New-Object IO.MemoryStream
$gz2.CopyTo($outMs)
$gz2.Dispose()
$sha = [Security.Cryptography.SHA256]::Create()
$h1 = [BitConverter]::ToString($sha.ComputeHash($bytes))
$h2 = [BitConverter]::ToString($sha.ComputeHash($outMs.ToArray()))
if ($h1 -ne $h2) { Write-Error "校验失败：解压结果与原文件不一致！"; exit 1 }

Write-Host ("OK  原始: {0:N0} B   gzip: {1:N0} B   嵌入JS后: {2:N0} B   实际加载量/原始: {3:P1}" -f $bytes.Length, $gzBytes.Length, $wrapper.Length, ($wrapper.Length / $bytes.Length))
Write-Host "已生成: $OutFile"
