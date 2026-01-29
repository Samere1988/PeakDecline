import re
from app import create_app, db
from app.models import Channel

app = create_app()
app.config["SQLALCHEMY_DATABASE_URI"] = "sqlite:///channels.db"
print("DB URI:", app.config["SQLALCHEMY_DATABASE_URI"])
with app.app_context():
    db.engine.dispose()
def extract_brand(name: str) -> str:
    name = name.lower()

    # remove common IPTV junk
    junk = [
        " hd", " fhd", " uhd", " 4k",
        " +1", " east", " west",
        " us", " uk", " ca",
        " channel", " network"
    ]
    for j in junk:
        name = name.replace(j, "")

    # remove standalone numbers (bbc 1 → bbc)
    name = re.sub(r"\b\d+\b", "", name)

    # collapse whitespace
    name = re.sub(r"\s+", " ", name).strip()

    return name

with app.app_context():
    channels = Channel.query.all()
    updated = 0

    for ch in channels:
        brand = extract_brand(ch.name)
        if ch.brand != brand:
            ch.brand = brand
            updated += 1

    db.session.commit()

print(f"✅ Brand extraction complete — updated {updated} channels")
