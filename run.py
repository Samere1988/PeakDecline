import os
from app import create_app, db

# Initialize the app using the Factory Pattern
app = create_app()

if __name__ == "__main__":
    # 1. Create the 'instance' folder if it doesn't exist
    # This prevents errors when the database tries to initialize
    if not os.path.exists(app.instance_path):
        os.makedirs(app.instance_path)
        print(f"Created instance folder at: {app.instance_path}")

    # 2. Create the database tables
    # On your test site, this will build 'test_channels.db' automatically
    with app.app_context():
        db.create_all()
        print("Database initialized.")

    port = int(os.environ.get("PORT", 9002))
    debug_mode = os.environ.get("FLASK_ENV") == "testing"

    print(f"Server starting in {'TESTING' if debug_mode else 'PRODUCTION'} mode...")
    print(f"Access your site at http://localhost:{port}")

    # 4. Run the application
    app.run(host="0.0.0.0", port=port, debug=debug_mode)