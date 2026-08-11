' ContentNode builders, shared by everything that produces grid content: the
' per-category fetches, and the Favorites grid rebuilding items out of
' /api/prefs.
'
' Why per-category rather than /api/library: this provider's Live section is
' 57,050 streams across 911 categories, and 10MB of JSON. Turning that into
' ContentNodes took 24 seconds and then the Roku killed the channel with
' EXIT_CHANNEL_MEM_LIMIT_FG. Only one category is ever on screen — about 63
' items on average — so the channel asks for one at a time.
'
' The cost is that these read Xtream's own field names, where /api/library
' handed over rows already projected. ProjectXtreamRow below mirrors
' projectItem() in server.js field for field; the two need to stay in step.

' section -> [categories action, streams action, item kind]
function SectionActions(section as String) as Object
    if section = "movies" then return ["get_vod_categories", "get_vod_streams", "movie"]
    if section = "series" then return ["get_series_categories", "get_series", "series"]
    return ["get_live_categories", "get_live_streams", "live"]
end function

' One raw Xtream row -> the projected shape BuildItemNode expects. Mirrors
' projectItem() in server.js, including which field carries the id and artwork
' for each kind — they differ per section.
function ProjectXtreamRow(row as Object, kind as String) as Object
    if kind = "live" then
        return {
            kind: kind,
            id: row.stream_id,
            name: row.name,
            logo: row.stream_icon,
            categoryId: row.category_id,
            epgId: row.epg_channel_id
        }
    end if

    if kind = "movie" then
        ext = AsText(row.container_extension)
        if ext = "" then ext = "mp4"
        return {
            kind: kind,
            id: row.stream_id,
            name: row.name,
            logo: row.stream_icon,
            categoryId: row.category_id,
            ext: ext,
            rating: row.rating
        }
    end if

    return {
        kind: kind,
        id: row.series_id,
        name: row.name,
        logo: row.cover,
        categoryId: row.category_id,
        rating: row.rating,
        genre: row.genre
    }
end function

' One row of /api/library, projected onto a ContentNode. Field names mirror
' projectItem() in server.js so the two read side by side.
'
' This runs once per row in the catalogue — thousands of times for Movies — so
' it stays as close to bare field assignment as it can. In particular it does
' NOT build the proxied poster URL. Percent-encoding is a per-byte loop, and
' paying it for every row cost far more than the whole rest of the load; the
' cards do it for the dozen or so posters actually on screen instead.
function BuildItemNode(row as Object) as Object
    node = CreateObject("roSGNode", "ContentNode")

    ' addFields takes initial values, so declaring and populating is one call
    ' into the node rather than ten. At this call count that is worth having.
    ' logo is the provider's own URL, not the proxied one — it is what a
    ' favorite stores, so the web player gets identical records back.
    node.addFields({
        itemKind: AsText(row.kind),
        itemId: AsText(row.id),
        catId: AsText(row.categoryId),
        ext: AsText(row.ext),
        rating: AsText(row.rating),
        genre: AsText(row.genre),
        epgId: AsText(row.epgId),
        logo: AsText(row.logo),
        isFavorite: false,
        rawName: AsText(row.name)
    })
    ' title is folded down to what this device can draw; rawName keeps the
    ' provider's original, because that is what a favorite writes back to
    ' /api/prefs and the web player renders those characters perfectly well.
    node.title = SafeText(node.rawName)

    return node
end function

' Derived rather than stored: one string join beats a field on every node in
' the catalogue, and it is only ever needed for items on screen.
function ItemFavKey(node as Object) as String
    if node = invalid then return ""
    return FavKey(node.itemKind, node.itemId)
end function

' The proxied poster, built at display time. Safe to call on the render thread.
function ItemPoster(node as Object) as String
    if node = invalid then return ""
    return ImageUrl(node.logo)
end function

' The inverse: a node turned back into the plain object /api/prefs stores, in
' the exact shape public/app.js writes so favorites round-trip between the two
' clients without either one losing fields.
function ItemNodeToRecord(node as Object) as Object
    record = {
        kind: node.itemKind,
        id: AsNumber(node.itemId),
        name: node.rawName,
        logo: node.logo,
        categoryId: node.catId
    }

    if node.itemKind = "movie" then record.ext = node.ext
    if node.rating <> "" then record.rating = node.rating
    if node.genre <> "" then record.genre = node.genre
    if node.epgId <> "" then record.epgId = node.epgId

    return record
end function

' A lightweight stand-in for a category, used as the category list's content.
' The real category node stays parented to the library tree — appending it to a
' second parent would move it out of there.
function BuildCategoryProxy(title as String, categoryId as String, count as Integer, pinned as Boolean, isSearch as Boolean) as Object
    node = CreateObject("roSGNode", "ContentNode")
    node.addFields({
        catId: categoryId,
        itemCount: count,
        pinned: pinned,
        isSearch: isSearch
    })
    node.title = title
    return node
end function
