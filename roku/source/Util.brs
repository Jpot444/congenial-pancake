' Small conversions shared by every thread.

' ParseJson hands back Integer, LongInteger, Double or String depending on how
' the provider wrote the field, and stream ids arrive both ways. Normalise
' everything to the string form the API expects back.
function AsText(value as Dynamic) as String
    if value = invalid then return ""

    kind = type(value)
    if kind = "String" or kind = "roString" then return value
    if kind = "Integer" or kind = "roInt" or kind = "roInteger" then return value.ToStr()
    if kind = "LongInteger" or kind = "roLongInteger" then return value.ToStr()
    if kind = "Float" or kind = "roFloat" or kind = "Double" or kind = "roDouble" then
        ' Ids and counts are whole numbers; Str() on a float would add a
        ' decimal tail that the provider then fails to match.
        return Str(Int(value)).Trim()
    end if
    if kind = "Boolean" or kind = "roBoolean" then
        if value then return "true"
        return "false"
    end if

    return ""
end function

function AsNumber(value as Dynamic) as Integer
    text = AsText(value)
    if text = "" then return 0
    return Int(Val(text))
end function

' Joins the parts of a metadata line, skipping the ones the provider left blank
' so we never render "2019 ·  · ".
function JoinParts(parts as Object, separator as String) as String
    out = ""
    for each part in parts
        text = AsText(part).Trim()
        if text <> "" then
            if out <> "" then out = out + separator
            out = out + text
        end if
    end for
    return out
end function

' Xtream reports runtimes as either "1:52:30" or a bare count of seconds.
' Both turn into something worth putting on screen.
function FormatRuntime(raw as Dynamic) as String
    text = AsText(raw).Trim()
    if text = "" then return ""
    if Instr(1, text, ":") > 0 then
        parts = text.Split(":")
        if parts.Count() = 3 then
            hours = Int(Val(parts[0]))
            minutes = Int(Val(parts[1]))
            if hours > 0 then return hours.ToStr() + "h " + minutes.ToStr() + "m"
            return minutes.ToStr() + "m"
        end if
        return text
    end if

    seconds = Int(Val(text))
    if seconds <= 0 then return ""
    hours = seconds \ 3600
    minutes = (seconds mod 3600) \ 60
    if hours > 0 then return hours.ToStr() + "h " + minutes.ToStr() + "m"
    return minutes.ToStr() + "m"
end function

' ---------------------------------------------------------------- text
'
' Provider listings decorate names with characters no font on the device has a
' glyph for, and a missing glyph draws as an empty box. Bundling DejaVu Sans
' fixed the ordinary cases — accents, box-drawing rules, the superscript "ᴴᴰ" —
' but nothing covers emoji, flag pairs, or letters from the mathematical
' alphanumeric blocks, and no font we could ship would.
'
' So anything still unrenderable is folded down to plain ASCII where it has an
' obvious equivalent, and dropped where it does not. "𝐇𝐃" becomes "HD", a flag
' disappears, and the name beside it stays readable.

function SafeText(text as String) as String
    if text = "" then return text

    bytes = CreateObject("roByteArray")
    bytes.FromAsciiString(text)
    total = bytes.Count()

    ' Most titles are plain ASCII and need none of this.
    for i = 0 to total - 1
        if bytes[i] > 127 then
            return TransliterateBytes(bytes, total)
        end if
    end for

    return text
end function

function TransliterateBytes(bytes as Object, total as Integer) as String
    out = CreateObject("roByteArray")
    scratch = CreateObject("roByteArray")

    i = 0
    while i < total
        lead = bytes[i]

        ' Decode one UTF-8 sequence to its codepoint.
        size = 1
        code = lead
        if lead >= &hF0 then
            size = 4
            code = lead and &h07
        else if lead >= &hE0 then
            size = 3
            code = lead and &h0F
        else if lead >= &hC0 then
            size = 2
            code = lead and &h1F
        end if

        if i + size > total then
            ' Truncated sequence — pass the byte through rather than guess.
            size = 1
            code = lead
        else
            for k = 1 to size - 1
                code = (code * 64) + (bytes[i + k] and &h3F)
            end for
        end if

        swap = Transliterate(code)
        if swap = invalid then
            ' Renderable: copy the original bytes through untouched.
            for k = 0 to size - 1
                out.Push(bytes[i + k])
            end for
        else if swap <> "" then
            scratch.FromAsciiString(swap)
            out.Append(scratch)
        end if

        i = i + size
    end while

    return out.ToAsciiString()
end function

' invalid means "leave it alone"; "" means drop it.
function Transliterate(code as Integer) as Dynamic
    if code < 128 then return invalid

    ' Fullwidth Latin, used to pad names out.
    if code >= &hFF01 and code <= &hFF5E then return Chr(code - &hFEE0)

    ' Superscript digits, as in "4ᴷ".
    if code = &h00B9 then return "1"
    if code = &h00B2 then return "2"
    if code = &h00B3 then return "3"
    if code = &h2070 then return "0"
    if code >= &h2074 and code <= &h2079 then return Chr(&h34 + code - &h2074)

    ' Modifier capitals. "ᴴᴰ" is on half the channels in a listing, and DejaVu
    ' does carry these — folding them anyway keeps names sortable and legible
    ' at the sizes a grid tile allows.
    if code >= &h1D2C and code <= &h1D42 then
        letters = "A?B?DE?GHIJKLMN?O?PRTUW"
        letter = Mid(letters, code - &h1D2C + 1, 1)
        if letter = "?" then return ""
        return letter
    end if

    ' Mathematical alphanumerics: styled A-Z and a-z used as decoration. The
    ' blocks run 26 upper then 26 lower, so the offset gives back the letter.
    if code >= &h1D400 and code <= &h1D7CB then
        offset = (code - &h1D400) mod 52
        if offset < 26 then return Chr(65 + offset)
        return Chr(97 + offset - 26)
    end if

    ' Leftovers from emoji sequences, invisible but still counted.
    if code >= &hFE00 and code <= &hFE0F then return ""
    if code = &h200D or code = &h200B or code = &hFEFF then return ""

    ' Everything else outside the BMP is emoji, flags and pictographs.
    if code > &hFFFF then return ""

    return invalid
end function

' Keys must match public/app.js exactly or the two clients stop seeing each
' other's pins and favorites. Note the asymmetry: pins are keyed by tab
' ("movies"), favorites by item kind ("movie").
function PinKey(section as String, categoryId as String) as String
    return section + ":" + categoryId
end function

function FavKey(kind as String, id as String) as String
    return kind + ":" + id
end function
