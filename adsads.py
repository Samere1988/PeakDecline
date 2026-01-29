from app import create_app, db
from app.models import Channel

app = create_app()
app.config["SQLALCHEMY_DATABASE_URI"] = "sqlite:///channels.db"

with app.app_context():
    brands = (
        db.session.query(Channel.brand)
        .distinct()
        .order_by(Channel.brand)
        .all()
    )

for b in brands[:50]:
    print(b[0])

print("Total unique brands:", len(brands))
