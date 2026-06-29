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
- Tracks event-based plus/minus from even-strength goals for and against.
- Lets you select the exact five PHC skaters on the ice for each EV goal event.
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

## v2.1 update

This build removes the title text from file-share exports so iOS should stop creating an extra `text.txt` file when saving CSV/JSON exports to Files.

## v2.2 update

This build adds event-based plus/minus:

- PHC EV scoring plays now have a **Select 5** on-ice button.
- Opponent goals have their own section.
- Opponent EV goals also have a **Select 5** on-ice button.
- Player totals now include EV goals for on ice, EV goals against on ice, and plus/minus.
- CSV exports include plus/minus fields.
- A new **On-Ice Events CSV** export lists the five selected skaters for each EV goal event.
