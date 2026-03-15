-- Dev seed: admin / changeme
INSERT OR IGNORE INTO "user" (id, name, email) VALUES ('dev-user', 'Admin', 'admin');
INSERT OR IGNORE INTO app_passwords (id, user_id, name, password_hash, prefix) VALUES ('dev-pw', 'dev-user', 'Dev', '057ba03d6c44104863dc7361fe4578965d1887360f90a0895882e58a6248fc86', 'chan');
