' Where the Pi lives, and the handful of switches the user can flip from the
' Settings screen. Stored in the registry so a reinstall of the channel is the
' only thing that forgets them.

' A LAN address, not the Tailscale name the web player uses. Roku has no
' Tailscale client, so the TV cannot resolve kalshi.taila9b3f4.ts.net at all —
' it fails at DNS before it ever reaches the Pi. That ties the channel to the
' home network, which for a television is no great loss.
'
' Give the Pi a DHCP reservation on the router. This is a lease, and when it
' moves the channel just stops finding the server.
function ConfigDefaultBase() as String
    return "http://192.168.1.18:8420"
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
    stored = ConfigRead("baseUrl", "")
    if stored <> "" and not ConfigIsUnreachable(stored) then
        return ConfigNormalizeBase(stored)
    end if
    return ConfigNormalizeBase(ConfigDefaultBase())
end function

' A tailnet name can never resolve here — there is no Tailscale client on a
' Roku, so the request dies at DNS. One in the registry is a leftover from the
' build whose default it was, and honouring it strands the channel on a server
' it cannot reach, with no way back except retyping on a TV keyboard.
function ConfigIsUnreachable(address as String) as Boolean
    return Instr(1, LCase(address), ".ts.net") > 0
end function

sub ConfigSetBaseUrl(raw as String)
    ConfigWrite("baseUrl", ConfigNormalizeBase(raw))
end sub

' Back to whatever this build ships with. Deleting the key rather than writing
' the default means a later build's default takes effect too.
sub ConfigClearBaseUrl()
    section = ConfigSection()
    if section.Exists("baseUrl") then
        section.Delete("baseUrl")
        section.Flush()
    end if
end sub

' ------------------------------------------------- what this box can't play
'
' Nothing in the provider's listing says what a stream contains, so there is no
' way to know a title will fail until it does. This is learned by trying: a
' channel that gets all the way through the fallbacks and still won't open is
' remembered, and marked in the grid from then on.
'
' Deliberately in the registry rather than /api/prefs. Decoder support is a
' property of this television, not of the account — the web player opens these
' streams perfectly well, and syncing the list would wrongly hide them there.

function ConfigUnplayable() as Object
    keys = {}

    raw = ConfigRead("unplayable", "")
    if raw = "" then return keys

    parsed = ParseJson(raw)
    if parsed = invalid or type(parsed) <> "roArray" then return keys

    for each key in parsed
        text = AsText(key)
        if text <> "" then keys[text] = true
    end for

    return keys
end function

sub ConfigSaveUnplayable(keys as Object)
    list = []
    for each key in keys
        ' A registry section is capped, and a few hundred is far more than a
        ' household will ever accumulate.
        if list.Count() >= 400 then exit for
        list.Push(key)
    end for
    ConfigWrite("unplayable", FormatJson(list))
end sub

' Marked by default rather than hidden: a title that failed once may be a
' provider hiccup, and silently vanishing content is worse than a label.
function ConfigHideUnplayable() as Boolean
    return ConfigRead("hideUnplayable", "0") = "1"
end function

sub ConfigSetHideUnplayable(enabled as Boolean)
    if enabled then
        ConfigWrite("hideUnplayable", "1")
    else
        ConfigWrite("hideUnplayable", "0")
    end if
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
