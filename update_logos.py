import os
import requests
from app import create_app, db
from app.models import Channel

# --- MASTER LOGO LIST ---
# We download these ONCE and link many channels to them.
BRANDS = {
    "ufc": "https://commons.wikimedia.org/wiki/Special:FilePath/UFC_Logo.svg",
    "sky_sports_f1": "https://commons.wikimedia.org/wiki/Special:FilePath/Sky_Sports_F1_logo_2020.svg",
    "sky_sports_news": "https://commons.wikimedia.org/wiki/Special:FilePath/Sky_Sports_News_logo_2020.svg",
    "sky_sports_golf": "https://commons.wikimedia.org/wiki/Special:FilePath/Sky_Sports_Golf_logo_2020.svg",
    "sky_sports_cricket": "https://commons.wikimedia.org/wiki/Special:FilePath/Sky_Sports_Cricket_logo_2020.svg",
    "sky_sports_football": "https://commons.wikimedia.org/wiki/Special:FilePath/Sky_Sports_Football_logo_2020.svg",
    "sky_sports_main": "https://commons.wikimedia.org/wiki/Special:FilePath/Sky_Sports_Logo_2020.svg",
    "tnt_sports": "https://commons.wikimedia.org/wiki/Special:FilePath/TNT_Sports_(2023).svg",
    "hbo": "https://commons.wikimedia.org/wiki/Special:FilePath/HBO_logo.svg",
    "bbc_earth": "https://commons.wikimedia.org/wiki/Special:FilePath/BBC_Earth_logo.svg",
    "bbc_main": "https://commons.wikimedia.org/wiki/Special:FilePath/BBC_Logo_2021.svg",
    "comedy_central": "https://commons.wikimedia.org/wiki/Special:FilePath/Comedy_Central_2018.svg",
    "amc": "https://commons.wikimedia.org/wiki/Special:FilePath/AMC_Network_logo.svg",
    "syfy": "https://commons.wikimedia.org/wiki/Special:FilePath/Syfy_2017.svg",
}

# --- MATCHING RULES (Order Matters!) ---
# If a channel name contains the "Keyword", we use the "Brand ID"
RULES = [
    ("ufc", "ufc"),
    ("sky sports f1", "sky_sports_f1"),
    ("sky sports news", "sky_sports_news"),
    ("sky sports golf", "sky_sports_golf"),
    ("sky sports cricket", "sky_sports_cricket"),
    ("sky sports football", "sky_sports_football"),
    ("sky sports", "sky_sports_main"),  # Catch-all for other Sky channels
    ("tnt", "tnt_sports"),
    ("hbo", "hbo"),
    ("bbc earth", "bbc_earth"),
    ("bbc", "bbc_main"),
    ("comedy central", "comedy_central"),
    ("amc", "amc"),
    ("syfy", "syfy"),
]

app = create_app()


def smart_fix():
    save_dir = os.path.join(app.root_path, 'static', 'img', 'logos')
    os.makedirs(save_dir, exist_ok=True)

    headers = {'User-Agent': 'PeakDeclineBot/2.0'}

    # 1. Download Master Files First
    print("⬇️  Downloading Master Brand Logos...")
    for brand_id, url in BRANDS.items():
        # Determine extension from URL
        ext = "svg" if "svg" in url.lower() else "png"
        filename = f"{brand_id}.{ext}"
        path = os.path.join(save_dir, filename)

        # Only download if we don't have it yet
        if not os.path.exists(path):
            try:
                r = requests.get(url, headers=headers, allow_redirects=True)
                if r.status_code == 200:
                    with open(path, 'wb') as f:
                        f.write(r.content)
                    print(f"   ✅ Saved: {filename}")
                else:
                    print(f"   ❌ Failed to download {brand_id}")
            except Exception as e:
                print(f"   ❌ Error {brand_id}: {e}")
        else:
            print(f"   ⚡ Exists: {filename}")

    # 2. Link Channels to Master Files
    print("\n🔗 Linking Channels to Master Logos...")
    with app.app_context():
        channels = Channel.query.all()
        count = 0

        for ch in channels:
            name_lower = ch.name.lower()
            target_brand = None

            # Find the best matching rule
            for keyword, brand_id in RULES:
                if keyword in name_lower:
                    target_brand = brand_id
                    break  # Stop at the first (most specific) match

            if target_brand:
                # Find the actual file we saved
                # We check for svg or png
                logo_path = None
                if os.path.exists(os.path.join(save_dir, f"{target_brand}.svg")):
                    logo_path = f"/static/img/logos/{target_brand}.svg"
                elif os.path.exists(os.path.join(save_dir, f"{target_brand}.png")):
                    logo_path = f"/static/img/logos/{target_brand}.png"

                if logo_path:
                    ch.logo = logo_path
                    count += 1
                    # print(f"   Linked '{ch.name}' -> {target_brand}")

        db.session.commit()
        print(f"\n✨ SUCCESS: Updated {count} channels to use master logos!")


if __name__ == "__main__":
    smart_fix()