sub init()
    m.top.functionName = "execute"
end sub

sub execute()
    ' Give up rather than sit on a spinner forever if ffmpeg wedges. Each pass
    ' is a status call plus a one second sleep, so this is a floor of ten
    ' minutes, not an exact one.
    maxPolls = 600

    params = m.top.params
    if params = invalid then params = {}

    ' Starting the conversion can take a moment: the server ffprobes the
    ' source over the provider link before ffmpeg gets going.
    started = HttpRequest({ url: ApiUrl("/api/remux", params), timeout: 120000 })
    if not started.ok then
        m.top.result = { ok: false, url: "", session: "", duration: 0, error: started.error }
        return
    end if

    data = JsonObject(started)
    url = AbsoluteUrl(data.url)
    session = AsText(data.session)
    duration = AsNumber(data.sourceDuration)

    target = AsNumber(data.prebuffer)
    if target <= 0 then target = 45

    if session = "" then
        ' Nothing to wait on — hand the playlist over as-is.
        m.top.result = { ok: true, url: url, session: "", duration: duration, error: "" }
        return
    end if

    m.top.progress = { ready: 0, target: target, message: "Preparing…" }

    waited = 0
    while waited < maxPolls
        if m.top.cancel then
            m.top.result = { ok: false, url: url, session: session, duration: duration, error: "" }
            return
        end if

        status = HttpRequest({ url: ApiUrl("/api/remux/status", { id: session }), timeout: 15000 })
        if not status.ok then
            ' The session can be reaped out from under us once conversion has
            ' finished. The playlist is still on disk, so play it.
            exit while
        end if

        body = JsonObject(status)
        if IsTrue(body.failed) then
            reason = AsText(body.error)
            if reason = "" then reason = "Conversion failed"
            m.top.result = { ok: false, url: "", session: session, duration: duration, error: reason }
            return
        end if

        ready = AsNumber(body.seconds)
        shown = ready
        if shown > target then shown = target

        m.top.progress = {
            ready: shown,
            target: target,
            message: "Converting — " + shown.ToStr() + "s of " + target.ToStr() + "s ready"
        }

        ' Short titles finish before they ever reach the target; that is still
        ' the whole file, so it is still enough.
        if ready >= target or IsTrue(body.complete) then exit while

        sleep(1000)
        waited = waited + 1
    end while

    m.top.result = { ok: true, url: url, session: session, duration: duration, error: "" }
end sub

' A missing JSON field reads back as invalid, and comparing invalid to a
' boolean is a type mismatch at runtime rather than a false.
function IsTrue(value as Dynamic) as Boolean
    if value = invalid then return false
    if type(value) = "Boolean" or type(value) = "roBoolean" then return value
    return false
end function
