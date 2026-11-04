from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete, func, select
from sqlalchemy.dialects.sqlite import insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth import AuthContext, require_access
from app.db import get_db, get_write_db
from app.models import Collection, CollectionItem, Document
from app.queries import only_visible
from app.schemas import CollectionItems, CollectionOut, CollectionWrite

router = APIRouter(prefix='/api/collections', tags=['collections'])

NAME_TAKEN = 'You already have a collection with that name.'


def _own_collection(session: Session, auth: AuthContext, collection_id: int) -> Collection:
    collection = session.scalar(
        select(Collection).where(Collection.id == collection_id, Collection.user_id == auth.scope)
    )
    if collection is None:
        raise HTTPException(404, 'Collection not found.')
    return collection


@router.get('')
def list_collections(auth: AuthContext = Depends(require_access), db: Session = Depends(get_db)) -> list[CollectionOut]:
    rows = db.scalars(
        select(Collection).where(Collection.user_id == auth.scope).order_by(func.lower(Collection.name))
    ).all()
    return [CollectionOut.model_validate(row) for row in rows]


@router.post('', status_code=201)
def create_collection(
    body: CollectionWrite,
    auth: AuthContext = Depends(require_access),
    db: Session = Depends(get_write_db),
) -> CollectionOut:
    collection = Collection(user_id=auth.scope, name=body.name)
    db.add(collection)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, NAME_TAKEN) from None
    return CollectionOut.model_validate(collection)


@router.patch('/{collection_id}')
def rename_collection(
    collection_id: int,
    body: CollectionWrite,
    auth: AuthContext = Depends(require_access),
    db: Session = Depends(get_write_db),
) -> CollectionOut:
    collection = _own_collection(db, auth, collection_id)
    collection.name = body.name
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, NAME_TAKEN) from None
    return CollectionOut.model_validate(collection)


@router.delete('/{collection_id}', status_code=204)
def delete_collection(
    collection_id: int,
    auth: AuthContext = Depends(require_access),
    db: Session = Depends(get_write_db),
) -> None:
    """Only the grouping goes: the books in it stay in the library."""
    db.delete(_own_collection(db, auth, collection_id))
    db.commit()


@router.post('/{collection_id}/items', status_code=204)
def change_items(
    collection_id: int,
    body: CollectionItems,
    auth: AuthContext = Depends(require_access),
    db: Session = Depends(get_write_db),
) -> None:
    """Adding is idempotent, and removing something absent is fine: two tabs may race."""
    _own_collection(db, auth, collection_id)
    add = set(body.add)
    if add:
        visible = set(db.scalars(only_visible(select(Document.id).where(Document.id.in_(add)), auth)))
        if visible != add:
            raise HTTPException(404, 'Document not found.')
        db.execute(
            insert(CollectionItem)
            .values([{'collection_id': collection_id, 'document_id': doc_id} for doc_id in add])
            .on_conflict_do_nothing()
        )
    if body.remove:
        db.execute(delete(CollectionItem).where(
            CollectionItem.collection_id == collection_id, CollectionItem.document_id.in_(body.remove)
        ))
    db.commit()
