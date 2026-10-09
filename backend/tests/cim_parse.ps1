# Reads a .lyrx, or every layer member of an .aprx whose renderer is keyed on one field alone (color2 unless
# named), with Esri's own CIM deserializer (ArcGIS.Core.dll, no Pro session and no licence) and prints what it
# read back as JSON.
# usage: pwsh -NoProfile -File cim_parse.ps1 <ArcGIS.Core.dll> <file.lyrx|file.aprx> [field]
param([Parameter(Mandatory)][string]$Dll, [Parameter(Mandatory)][string]$Path, [string]$Field = "color2")
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$asm = [Reflection.Assembly]::LoadFrom($Dll)
$settings = [Activator]::CreateInstance($asm.GetType("ArcGIS.Core.CIM.JsonDeserializationSettings"))

function Parse([string]$json) {
    $typeName = ([regex]::Match($json, '"type"\s*:\s*"(\w+)"')).Groups[1].Value
    $asm.GetType("ArcGIS.Core.CIM.$typeName", $true).GetMethod("FromJson").Invoke($null, @($json, $settings))
}

function Hex($colour) {
    if ($null -eq $colour) { return $null }
    $v = $colour.Values
    "#{0:X2}{1:X2}{2:X2}" -f [int]$v[0], [int]$v[1], [int]$v[2]
}

function Describe($layer) {
    $renderer = $layer.Renderer
    $connection = $layer.FeatureTable.DataConnection
    $other = @($renderer.DefaultSymbol.Symbol.SymbolLayers)
    [ordered]@{
        name    = $layer.Name
        fields  = @($renderer.Fields)
        source  = [ordered]@{
            type      = if ($connection) { $connection.GetType().Name } else { $null }
            factory   = "$($connection.WorkspaceFactory)"
            workspace = $connection.WorkspaceConnectionString
            dataset   = $connection.Dataset
            kind      = "$($connection.DatasetType)"
        }
        other   = [ordered]@{
            used   = $renderer.UseDefaultSymbol
            label  = $renderer.DefaultLabel
            fill   = Hex (($other | Where-Object { $_.GetType().Name -eq "CIMSolidFill" } | Select-Object -First 1).Color)
            stroke = Hex (($other | Where-Object { $_.GetType().Name -eq "CIMSolidStroke" } | Select-Object -First 1).Color)
        }
        classes = @($renderer.Groups | ForEach-Object { $_.Classes } | ForEach-Object {
                $layers = @($_.Symbol.Symbol.SymbolLayers)
                [ordered]@{
                    label  = $_.Label
                    values = @($_.Values | ForEach-Object { $_.FieldValues[0] })
                    layers = @($layers | ForEach-Object { $_.GetType().Name })
                    fill   = Hex (($layers | Where-Object { $_.GetType().Name -eq "CIMSolidFill" } | Select-Object -First 1).Color)
                    stroke = Hex (($layers | Where-Object { $_.GetType().Name -eq "CIMSolidStroke" } | Select-Object -First 1).Color)
                }
            })
    }
}

$layers = @()
$failed = @()
if ($Path.ToLower().EndsWith(".aprx")) {
    Add-Type -AssemblyName System.IO.Compression
    $zip = [IO.Compression.ZipFile]::OpenRead($Path)
    try {
        foreach ($entry in $zip.Entries) {
            $reader = [IO.StreamReader]::new($entry.Open(), [Text.Encoding]::UTF8)
            $text = $reader.ReadToEnd()
            $reader.Dispose()
            if ($text -notmatch '"CIMFeatureLayer"' -or -not $text.Contains('"fields":["' + $Field + '"]')) { continue }
            try { $layers += , (Describe (Parse $text)) } catch { $failed += $entry.FullName }
        }
    }
    finally { $zip.Dispose() }
}
else {
    $doc = Parse ([IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8))
    $layers = @($doc.LayerDefinitions | ForEach-Object { Describe $_ })
}
[ordered]@{ layers = $layers; failed = $failed } | ConvertTo-Json -Depth 8 -Compress
