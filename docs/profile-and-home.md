# Homepage and profiles

Install `requirements-profile.txt` in the app environment and restart the application to load this update. Pillow is installed in the local `.venv`.

Startup adds the nullable `avatar` column to the existing user table without replacing accounts. Uploaded images are validated, cropped to 256 by 256 JPEGs, and stored in `instance/avatars`. Back up that directory with `instance/users.db`. Profile updates use a session CSRF token; password changes require the current password and matching new passwords.

Catan statistics live in `catan_results` in the existing Catan database. Each normal match has a distinct match ID. Seated users count once when the match starts; an engine-declared winner counts once. Spectators, test rooms, and pre-update games are excluded. Rematches count separately. Resignations and abandoned matches do not award wins.

The shared navigation uses the existing logo as a home link. Avatar rendering covers Live TV messages, Watch Together messages, Catan chat/rosters, and Mario Kart rosters. Rooms without chat retain their existing controls.

Validation: four profile/statistics tests, 31 Catan tests, one Mario Kart avatar-roster test, JavaScript syntax checks, and desktop/narrow homepage/profile visual checks. The older Mario Kart suite uses outdated room creation and frame API fixtures and remains failing independently of the avatar integration.

The homepage redesign was reverted at the user's request. The original large logo and menu-card grid are restored, with a Profile card for signed-in users. Shared account navigation is omitted on the homepage. Profile features, avatars, and Catan statistics are retained.
