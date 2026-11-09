# Footage labeling guide (for Tristen)

Three folders per client: Reels, Drone, Photos. Name every file the same way. That is it.

## Folders

```
Footage/
  URC/
    Reels/      <- all video that is not drone (sound stays with the video)
    Drone/
    Photos/
```

## File name

```
CLIENT_TYPE_DATE_Subject_LABEL_001.ext
```

Example: `URC_REEL_20261105_BraxtonBuild_BROLL_004.mp4`

| Part | What to put |
|---|---|
| CLIENT | client code from the list below |
| TYPE | `REEL`, `DRONE`, or `PHOTO` (same as the folder) |
| DATE | day shot, like `20261105` |
| Subject | who or what is in it, one or two words, no spaces |
| LABEL | what it is, from the list below |
| 001 | counts up: 001, 002, 003 |

## Labels

| Type | Pick one |
|---|---|
| REEL | HOOK (talking head hook), TALK (any other talking head, interviews and testimonials too), BROLL, PRODUCT, EVENT |
| DRONE | AERIAL, ORBIT, TOPDOWN, STILL |
| PHOTO | TEAM, HEADSHOT, JOBSITE, PRODUCT, EVENT, LOCATION |

## Client codes

URC (Universal Roofing), SS (Sun & Shield), IFAB (iFab), ADN (Adnormous), BKVF (Brothers Keeper), ABLS (America's Best Lighting), MTCH (Matchett Homes), NITRO (Nitro Pro Racing), CISGA (Communities In Schools of Georgia), VNPHC (Visiting Nurse Private Home Care), OHM (Open Heart Media).

## Rules

- Letters and numbers only, with underscores between the parts. No spaces.
- Not sure of the subject? Write `Misc`. Every file gets a type and a label, no exceptions.
- Rename copies, never the originals.

---

## For the build (system side)

**Regex:**
`^(?<client>[A-Z]{2,6})_(?<type>REEL|DRONE|PHOTO)_(?<date>\d{8})_(?<subject>[A-Za-z0-9]+)_(?<label>[A-Z]+)_(?<seq>\d{3})\.(?<ext>[A-Za-z0-9]+)$`

**Checks:** client matches the client folder; TYPE matches the type folder; label is allowed for the type; a file that fails is flagged back to the uploader to rename, never filed under a guess.

**Asset record:** client, type, date, subject, label, seq, ext, drive_file_id, original_name, duration, orientation. Calendar links and approvals get added later as separate data, so file names never change. Release status is not tracked in the file name: everyone on camera is cleared.
