# scripts

`extract-bison.js` regenerates `public/bison.png` from the Treasure State logo
plate. Only needed if the mark itself changes.

    sips -s format png "/path/to/Treasure state_back.jpg" --out /tmp/logo.png
    node scripts/extract-bison.js /tmp/logo.png public/bison.png 0.39

The final argument is how far across the plate to look for the emblem, as a
fraction of width. 0.39 stops just before the vertical rule that divides the
bison from the wordmark; raising it pulls that rule into the crop.
