' URL building for the portal's API. Nothing here talks to the network — see
' Http.brs for that — so these are safe to call from the render thread.

' Percent-encoding done by hand rather than through roUrlTransfer.Escape, so
' the render thread never has to create a transfer object just to build a link.
function UrlEscape(text as String) as String
    digits = "0123456789ABCDEF"
    bytes = CreateObject("roByteArray")
    bytes.FromAsciiString(text)

    out = ""
    for each code in bytes
        isAlpha = (code >= 65 and code <= 90) or (code >= 97 and code <= 122)
        isDigit = (code >= 48 and code <= 57)
        isMark = (code = 45) or (code = 46) or (code = 95) or (code = 126)  ' - . _ ~
        if isAlpha or isDigit or isMark then
            out = out + Chr(code)
        else
            out = out + "%" + Mid(digits, (code \ 16) + 1, 1) + Mid(digits, (code mod 16) + 1, 1)
        end if
    end for

    return out
end function

' Empty and invalid params are dropped rather than sent blank — server.js reads
' several of them with `|| default`, and an empty string is not the same as absent.
function ApiUrl(path as String, params as Dynamic) as String
    url = ConfigBaseUrl() + path
    if params = invalid then return url

    separator = "?"
    if Instr(1, path, "?") > 0 then separator = "&"

    for each key in params
        value = AsText(params[key])
        if value <> "" then
            url = url + separator + key + "=" + UrlEscape(value)
            separator = "&"
        end if
    end for

    return url
end function

' Posters and channel logos are frequently http-only or hotlink-blocked, so
' they go through the Pi. Note /img takes a plain URL — unlike /stream, which
' takes a base64url one; the server decodes them differently.
function ImageUrl(raw as Dynamic) as String
    text = AsText(raw)
    if text = "" then return ""
    if Left(LCase(text), 4) <> "http" then return ""
    return ApiUrl("/img", { u: text })
end function

' /api/play and /api/remux both answer with a server-relative path.
function AbsoluteUrl(path as Dynamic) as String
    text = AsText(path)
    if text = "" then return ""
    if Left(LCase(text), 4) = "http" then return text
    if Left(text, 1) <> "/" then text = "/" + text
    return ConfigBaseUrl() + text
end function

' Containers the Video node opens without help. Everything else is handed to
' /api/remux first. Mirrors NATIVE_CONTAINERS in public/app.js, plus the
' optional .mkv opt-in from Settings.
function IsNativeContainer(ext as Dynamic) as Boolean
    text = LCase(AsText(ext))
    if text = "" then return true  ' nothing to convert if we were told nothing
    if text = "mp4" or text = "m4v" or text = "mov" then return true
    if text = "mkv" and ConfigNativeMkv() then return true
    return false
end function

' What to hand the Video node's streamFormat. The server reports the container
' it resolved; live comes back as m3u8 because the Pi's preferredFormat is m3u8.
function StreamFormatFor(format as Dynamic) as String
    text = LCase(AsText(format))
    if text = "m3u8" or text = "hls" then return "hls"
    if text = "ts" then return "ts"
    if text = "mkv" then return "mkv"
    if text = "mpd" or text = "dash" then return "dash"
    return "mp4"
end function
