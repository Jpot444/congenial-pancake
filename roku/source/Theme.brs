' The web player's palette, in the 0xRRGGBBAA form SceneGraph wants. Kept in
' one place so the channel and public/styles.css can be nudged together.
'
' Only the entries that change at runtime — focus states, mostly — are read
' from here. The rest are the same values the XML sets as literals, and are
' listed so there is one table to check them against.

function Theme() as Object
    return {
        bg:        "0x15100FFF",
        bgRaised:  "0x1D1715FF",
        bgCard:    "0x241C1AFF",
        line:      "0x3A2D2AFF",
        lineSoft:  "0x2A211FFF",
        text:      "0xF6F1EEFF",
        muted:     "0xA3928CFF",
        mutedDim:  "0x705F5AFF",
        live:      "0xFF6B5EFF",
        brand:     "0xA21F24FF",
        brandDeep: "0x6E1418FF",
        scrim:     "0x0B0807E6"
    }
end function

' The web player sets --display on every heading, the eyebrow labels and the
' LIVE pill, and leaves body copy on the system stack. Bebas Neue is that face;
' it ships here as a TTF converted from the same woff2 public/ serves, so the
' two players are literally running the same typeface.
'
' Bebas is drawn caps-only — lowercase codepoints map to the same glyphs — so
' UCase() on heading text is about matching the CSS text-transform, not about
' avoiding missing glyphs.
function FontDisplay() as String
    return "pkg:/fonts/BebasNeue.ttf"
end function
