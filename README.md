# PHC 15U Stats App Public Shell

This folder contains only the blank app shell. It does not contain the roster.

## Deploying to GitHub Pages

1. Create a new GitHub repository.
2. Upload only the files from this `phc15u-stats-app-public` folder.
3. In GitHub, open Settings → Pages.
4. Publish from the main branch/root folder.
5. Open the published URL in Safari on the iPhone.
6. Tap Share → Add to Home Screen.
7. Open the installed app and import the private roster JSON from Files/iCloud Drive.

## Files that should stay private

Do not upload any of these to GitHub Pages:

- roster import JSON files
- full backup JSON files
- exported game/stat CSV files if they contain player information

## What the app does

- Runs from the iPhone Home Screen as a PWA.
- Works offline after the first successful load.
- Stores roster and game data locally on the device using IndexedDB.
- Tracks scoring plays, PP player stats, team PP/PK, player PIM, team shots, and individual goalie stats.
- Exports CSV files for Google Sheets/Excel.
- Exports/imports full JSON backups for restore.

## Version 2 design choices

- No roster embedded in public app files.
- No login.
- No paid hosting.
- No Google Sheets live sync.
- No App Store deployment.
- No player shots on goal.
- Opponent shots are calculated from individual goalie shots against.
- PP player stats are generated from scoring plays marked as PP.
- PK stats are team-level only.
- Goalie minutes are whole numbers.
- Default regulation game length is 51 minutes.
