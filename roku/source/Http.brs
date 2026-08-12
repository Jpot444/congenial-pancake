' One HTTP helper, shared by every Task node. Must only be called from a task
' thread — roUrlTransfer blocks, and blocking the render thread freezes the UI.
'
' req:  { url, method, body, timeout, accept }
' out:  { ok, status, error, json, text }

function HttpRequest(req as Object) as Object
    result = { ok: false, status: 0, error: "", json: invalid, text: "", bytes: 0 }

    if req = invalid or AsText(req.url) = "" then
        result.error = "No URL to request"
        return result
    end if

    timeout = 30000
    if req.timeout <> invalid then timeout = req.timeout

    port = CreateObject("roMessagePort")
    xfer = CreateObject("roUrlTransfer")
    xfer.SetMessagePort(port)
    xfer.SetUrl(req.url)
    xfer.EnableEncodings(true)
    xfer.RetainBodyOnError(true)
    xfer.AddHeader("Accept", "application/json")

    ' The Pi is plain http, but nothing stops someone pointing this at an
    ' https reverse proxy from Settings.
    if Left(LCase(req.url), 6) = "https:" then
        xfer.SetCertificatesFile("common:/certs/ca-bundle.crt")
        xfer.InitClientCertificates()
    end if

    method = "GET"
    if AsText(req.method) <> "" then method = UCase(AsText(req.method))

    started = false
    if method = "GET" then
        started = xfer.AsyncGetToString()
    else
        xfer.SetRequest(method)
        xfer.AddHeader("Content-Type", "application/json")
        started = xfer.AsyncPostFromString(AsText(req.body))
    end if

    if not started then
        result.error = "Could not reach " + ConfigBaseUrl()
        return result
    end if

    msg = wait(timeout, port)
    if msg = invalid then
        xfer.AsyncCancel()
        result.error = "The Pi did not answer within " + (timeout \ 1000).ToStr() + "s"
        return result
    end if

    if type(msg) <> "roUrlEvent" then
        result.error = "Unexpected reply from " + ConfigBaseUrl()
        return result
    end if

    result.status = msg.GetResponseCode()
    result.text = msg.GetString()

    ' A negative code is a transport failure — DNS, refused, TLS — not an HTTP
    ' status, and GetFailureReason is the only thing that says which.
    if result.status <= 0 then
        reason = msg.GetFailureReason()
        if reason = invalid or reason = "" then reason = "connection failed"
        result.error = "Can't reach " + ConfigBaseUrl() + " (" + reason + ")"
        return result
    end if

    result.bytes = Len(result.text)
    result.json = ParseJson(result.text)

    if result.status >= 400 then
        result.error = HttpErrorText(result)
        return result
    end if

    if result.json = invalid then
        result.error = "The Pi sent something that wasn't JSON"
        return result
    end if

    ' A library payload runs to megabytes, and the parsed copy is what every
    ' caller actually reads. Holding the raw text alongside it doubles the peak
    ' for no benefit — and peak memory is what kills the channel on the big
    ' sections. Kept only when parsing failed, where it is the evidence.
    result.text = ""

    result.ok = true
    return result
end function

' Callers want to read named fields off a reply. The provider can answer an
' otherwise-fine request with a bare array, and reaching for a field on one of
' those is a runtime error — so hand back an empty object instead.
function JsonObject(response as Dynamic) as Object
    if response = invalid then return {}
    if response.json = invalid then return {}
    if type(response.json) <> "roAssociativeArray" then return {}
    return response.json
end function

' server.js answers every failure as { error: "..." }, which is far more useful
' on screen than the status code on its own.
function HttpErrorText(result as Object) as String
    if result.json <> invalid and type(result.json) = "roAssociativeArray" then
        detail = AsText(result.json.error)
        if detail <> "" then return detail
    end if
    return "HTTP " + result.status.ToStr()
end function
