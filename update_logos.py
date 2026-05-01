from app import create_app, db

# DO NOT import User or Room here yet

app = create_app()

with app.app_context():
    # Import models INSIDE the app context block to avoid the double-load error
    from app.models import User, Room

    # Now it is safe to create tables
    db.create_all()
    print("Database updated successfully!")