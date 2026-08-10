' Where the Pi lives, and the handful of switches the user can flip from the
' Settings screen. Stored in the registry so a reinstall of the channel is the
' only thing that forgets them.

function ConfigDefaultBase() as String
    return "http://kalshi.taila9b3f4.ts.net:8420"
end function

function ConfigSection() as Object
    return CreateObject("roRegistrySection", "portal")
end function

function ConfigRead(key as String, fallback as String) as String
    section = ConfigSection()
    if section.Exists(key) then
        value = section.Read(key)
        if value <> invalid and value <> "" then return value
    end if
    return fallback
end function

sub ConfigWrite(key as String, value as String)
    section = ConfigSection()
    section.Write(key, value)
    section.Flush()
end sub

' Accepts what someone would actually type on a remote — "192.168.1.20:8420",
' "kalshi.taila9b3f4.ts.net", a full URL with a stray trailing slash — and
' turns it into a base we can concatenate paths onto.
function ConfigNormalizeBase(raw as String) as String
    text = raw.Trim()
    if text = "" then return ConfigDefaultBase()

    lower = LCase(text)
    if Left(lower, 7) <> "http://" and Left(lower, 8) <> "https://" then
        text = "http://" + text
    end if

    while Len(text) > 0 and Right(text, 1) = "/"
        text = Left(text, Len(text) - 1)
    end while

    ' A bare host with no port would hit :80, where nothing is listening.
    if Instr(1, Mid(text, 8), ":") = 0 and Left(LCase(text), 7) = "http://" then
        text = text + ":8420"
    end if

    return text
end function

function ConfigBaseUrl() as String
    return ConfigNormalizeBase(ConfigRead("baseUrl", ConfigDefaultBase()))
end function

sub ConfigSetBaseUrl(raw as String)
    ConfigWrite("baseUrl", ConfigNormalizeBase(raw))
end sub

' Roku's Video node will open an .mkv, but only on models whose decoder matches
' what is inside it, and only after dragging the seek index over the proxy —
' which on a Pi behind Tailscale is a long silent stall. Off by default means
' every non-mp4 container goes through /api/remux, exactly like the web player.
' Turn it on from Settings if your Roku is a 4K model on a fast link.
function ConfigNativeMkv() as Boolean
    return ConfigRead("nativeMkv", "0") = "1"
end function

sub ConfigSetNativeMkv(enabled as Boolean)
    if enabled then
        ConfigWrite("nativeMkv", "1")
    else
        ConfigWrite("nativeMkv", "0")
    end if
end sub
