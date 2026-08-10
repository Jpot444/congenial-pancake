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

' Keys must match public/app.js exactly or the two clients stop seeing each
' other's pins and favorites. Note the asymmetry: pins are keyed by tab
' ("movies"), favorites by item kind ("movie").
function PinKey(section as String, categoryId as String) as String
    return section + ":" + categoryId
end function

function FavKey(kind as String, id as String) as String
    return kind + ":" + id
end function

' live -> live, movies -> movie, series -> series
function KindForTab(section as String) as String
    if section = "movies" then return "movie"
    if section = "series" then return "series"
    return "live"
end function
