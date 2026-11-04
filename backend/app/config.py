from pathlib import Path
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(case_sensitive=False, extra='ignore')

    data_dir: Path = Path('/data')
    frontend_dist: Path = Path('/app/frontend/dist')

    users_api_url: str = 'http://users-api:8000'
    allow_signup: bool = True
    auth_fail_mode: Literal['global', 'closed'] = 'global'
    max_upload_mb: int = 500
    # Extra browser origins allowed past the CSRF check (comma separated), for the Vite dev server.
    csrf_trusted_origins: str = ''

    health_ttl: float = 15.0
    token_ttl: float = 60.0
    # Budget for a health probe or token check; requests never wait longer than this.
    auth_timeout: float = 2.0
    # Password hashing makes login slower than the checks above.
    login_timeout: float = 15.0

    login_rate_limit: int = 10
    login_rate_window: float = 60.0

    ingest_open_timeout: float = 120.0
    ingest_page_timeout: float = 2.0
    ingest_max_timeout: float = 3600.0

    @property
    def users_api_base(self) -> str:
        return self.users_api_url.strip().rstrip('/')

    @property
    def max_upload_bytes(self) -> int:
        return self.max_upload_mb * 1024 * 1024

    @property
    def trusted_origins(self) -> set[str]:
        return {o.strip().rstrip('/') for o in self.csrf_trusted_origins.split(',') if o.strip()}

    @property
    def database_url(self) -> str:
        return f'sqlite:///{self.data_dir / "library.sqlite3"}'

    @property
    def legacy_db(self) -> Path:
        return self.data_dir / 'reader.sqlite3'

    @property
    def pdf_dir(self) -> Path:
        return self.data_dir / 'pdfs'

    @property
    def derived_dir(self) -> Path:
        return self.data_dir / 'derived'

    @property
    def tmp_dir(self) -> Path:
        return self.data_dir / 'tmp'

    def ensure_dirs(self) -> None:
        for path in (self.data_dir, self.pdf_dir, self.derived_dir, self.tmp_dir):
            path.mkdir(parents=True, exist_ok=True)
