from flask import current_app
from plexapi.server import PlexServer


def get_plex_server():
    """Connect to local Plex Server."""
    try:
        # We access the config we set in __init__.py
        url = current_app.config.get('PLEX_URL')
        token = current_app.config.get('PLEX_TOKEN')

        if not url or not token:
            return None

        return PlexServer(url, token)
    except Exception as e:
        print(f"Error connecting to Plex: {e}")
        return None