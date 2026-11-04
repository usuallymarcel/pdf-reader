from logging.config import fileConfig

from alembic import context

from app import models  # noqa: F401  (registers the tables on Base.metadata)
from app.config import Settings
from app.db import Base, build_engine

config = context.config

if config.config_file_name is not None and config.attributes.get('configure_logging', True):
    fileConfig(config.config_file_name, disable_existing_loggers=False)


def run_migrations_online() -> None:
    url = config.attributes.get('database_url')
    if url is None:
        settings = Settings()
        settings.ensure_dirs()
        url = settings.database_url
    engine = build_engine(url)
    with engine.begin() as connection:
        context.configure(connection=connection, target_metadata=Base.metadata, render_as_batch=True)
        with context.begin_transaction():
            context.run_migrations()
    engine.dispose()


if context.is_offline_mode():
    raise SystemExit('Offline migrations are not supported.')
run_migrations_online()
