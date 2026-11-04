"""Collections, and which extractor produced a document's text.

Existing rows get text_version 0, so the worker re-reads their text once in the background.

Revision ID: 0002
Revises: 0001
"""
from alembic import op
import sqlalchemy as sa

from app.db import UTCDateTime

revision = '0002'
down_revision = '0001'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Plain ALTER TABLE on purpose: rebuilding this table would fire its foreign key cascades and
    # lose the expression index, which reflection cannot see.
    op.execute('ALTER TABLE documents ADD COLUMN text_version INTEGER NOT NULL DEFAULT 0')
    op.create_table(
        'collections',
        sa.Column('id', sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column('user_id', sa.Integer(), nullable=False),
        sa.Column('name', sa.Text(), nullable=False),
        sa.Column('created_at', UTCDateTime(), nullable=False),
        sa.UniqueConstraint('user_id', 'name'),
    )
    op.create_table(
        'collection_items',
        sa.Column('collection_id', sa.Integer(), sa.ForeignKey('collections.id', ondelete='CASCADE'), primary_key=True),
        sa.Column('document_id', sa.String(32), sa.ForeignKey('documents.id', ondelete='CASCADE'), primary_key=True),
    )
    op.create_index('ix_collection_items_document_id', 'collection_items', ['document_id'])


def downgrade() -> None:
    op.drop_index('ix_collection_items_document_id', 'collection_items')
    op.drop_table('collection_items')
    op.drop_table('collections')
    op.execute('ALTER TABLE documents DROP COLUMN text_version')
