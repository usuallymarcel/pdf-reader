"""Initial schema, including the trigram full-text index.

Revision ID: 0001
Revises:
"""
from alembic import op
import sqlalchemy as sa

from app.db import UTCDateTime

revision = '0001'
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'documents',
        sa.Column('id', sa.String(32), primary_key=True),
        sa.Column('owner_id', sa.Integer(), nullable=True),
        sa.Column('filename', sa.Text(), nullable=False),
        sa.Column('stored_name', sa.Text(), nullable=False),
        sa.Column('sha256', sa.String(64), nullable=True),
        sa.Column('size', sa.BigInteger(), nullable=False),
        sa.Column('title', sa.Text(), nullable=False),
        sa.Column('series', sa.Text(), nullable=True),
        sa.Column('volume', sa.Float(), nullable=True),
        sa.Column('author', sa.Text(), nullable=True),
        sa.Column('kind', sa.String(16), nullable=False),
        sa.Column('direction', sa.String(8), nullable=True),
        sa.Column('suggested_mode', sa.String(16), nullable=False),
        sa.Column('edited_fields', sa.JSON(), nullable=False),
        sa.Column('page_count', sa.Integer(), nullable=False),
        sa.Column('page_sizes', sa.JSON(), nullable=False),
        sa.Column('outline', sa.JSON(), nullable=False),
        sa.Column('has_text', sa.Boolean(), nullable=False),
        sa.Column('status', sa.String(16), nullable=False),
        sa.Column('error', sa.Text(), nullable=True),
        sa.Column('cover_version', sa.String(32), nullable=True),
        sa.Column('created_at', UTCDateTime(), nullable=False),
        sa.Column('updated_at', UTCDateTime(), nullable=False),
    )
    op.create_index('ix_documents_owner_id', 'documents', ['owner_id'])
    op.create_index('ix_documents_status', 'documents', ['status'])
    op.execute('CREATE UNIQUE INDEX uq_documents_owner_sha ON documents (coalesce(owner_id, 0), sha256)')

    op.create_table(
        'reading_states',
        sa.Column('user_id', sa.Integer(), primary_key=True),
        sa.Column('document_id', sa.String(32), sa.ForeignKey('documents.id', ondelete='CASCADE'), primary_key=True),
        sa.Column('page', sa.Integer(), nullable=False),
        sa.Column('offset', sa.Float(), nullable=False),
        sa.Column('max_page', sa.Integer(), nullable=False),
        sa.Column('finished', sa.Boolean(), nullable=False),
        sa.Column('favorite', sa.Boolean(), nullable=False),
        sa.Column('seconds_read', sa.Float(), nullable=False),
        sa.Column('overrides', sa.JSON(), nullable=False),
        sa.Column('last_read_at', UTCDateTime(), nullable=True),
        sa.Column('client_ts', sa.BigInteger(), nullable=False),
    )
    op.create_table(
        'reading_days',
        sa.Column('user_id', sa.Integer(), primary_key=True),
        sa.Column('date', sa.String(10), primary_key=True),
        sa.Column('seconds', sa.Float(), nullable=False),
    )
    op.create_table(
        'bookmarks',
        sa.Column('id', sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column('user_id', sa.Integer(), nullable=False),
        sa.Column('document_id', sa.String(32), sa.ForeignKey('documents.id', ondelete='CASCADE'), nullable=False),
        sa.Column('page', sa.Integer(), nullable=False),
        sa.Column('note', sa.Text(), nullable=True),
        sa.Column('locator', sa.Integer(), nullable=True),
        sa.Column('created_at', UTCDateTime(), nullable=False),
    )
    op.create_index('ix_bookmarks_user_id', 'bookmarks', ['user_id'])
    op.create_index('ix_bookmarks_document_id', 'bookmarks', ['document_id'])
    op.create_table(
        'preferences',
        sa.Column('user_id', sa.Integer(), primary_key=True),
        sa.Column('data', sa.JSON(), nullable=False),
        sa.Column('updated_at', UTCDateTime(), nullable=False),
    )
    op.create_table(
        'page_text',
        sa.Column('id', sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column('document_id', sa.String(32), sa.ForeignKey('documents.id', ondelete='CASCADE'), nullable=False),
        sa.Column('page', sa.Integer(), nullable=False),
        sa.Column('text', sa.Text(), nullable=False),
        sa.UniqueConstraint('document_id', 'page'),
    )
    op.execute(
        "CREATE VIRTUAL TABLE page_fts USING fts5("
        "text, content='page_text', content_rowid='id', tokenize='trigram')"
    )
    op.execute(
        'CREATE TRIGGER page_text_ai AFTER INSERT ON page_text BEGIN '
        'INSERT INTO page_fts(rowid, text) VALUES (new.id, new.text); END'
    )
    op.execute(
        'CREATE TRIGGER page_text_ad AFTER DELETE ON page_text BEGIN '
        "INSERT INTO page_fts(page_fts, rowid, text) VALUES ('delete', old.id, old.text); END"
    )
    op.execute(
        'CREATE TRIGGER page_text_au AFTER UPDATE ON page_text BEGIN '
        "INSERT INTO page_fts(page_fts, rowid, text) VALUES ('delete', old.id, old.text); "
        'INSERT INTO page_fts(rowid, text) VALUES (new.id, new.text); END'
    )


def downgrade() -> None:
    for trigger in ('page_text_au', 'page_text_ad', 'page_text_ai'):
        op.execute(f'DROP TRIGGER {trigger}')
    op.execute('DROP TABLE page_fts')
    for table in ('page_text', 'preferences', 'bookmarks', 'reading_days', 'reading_states', 'documents'):
        op.drop_table(table)
