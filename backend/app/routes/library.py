from datetime import date, timedelta

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.auth import AuthContext, require_access
from app.db import get_db, utcnow
from app.models import Document, ReadingDay, ReadingState
from app.queries import collection_ids_by_document, doc_fields, only_visible
from app.schemas import DailySeconds, Doc, Stats

router = APIRouter(prefix='/api', tags=['library'])

STATS_DAYS = 30


@router.get('/library')
def library(auth: AuthContext = Depends(require_access), db: Session = Depends(get_db)) -> list[Doc]:
    documents = db.scalars(only_visible(select(Document), auth).order_by(Document.created_at.desc())).all()
    states = {
        state.document_id: state
        for state in db.scalars(select(ReadingState).where(ReadingState.user_id == auth.scope))
    }
    collections = collection_ids_by_document(db, auth)
    return [Doc(**doc_fields(doc, states.get(doc.id), auth, collections.get(doc.id))) for doc in documents]


def _streak(days: set[str], today: date) -> int:
    """Consecutive days ending today, or yesterday if today has no reading yet."""
    day = today if today.isoformat() in days else today - timedelta(days=1)
    streak = 0
    while day.isoformat() in days:
        streak += 1
        day -= timedelta(days=1)
    return streak


@router.get('/stats')
def stats(auth: AuthContext = Depends(require_access), db: Session = Depends(get_db)) -> Stats:
    visible_ids = only_visible(select(Document.id), auth)
    documents = db.scalar(select(func.count()).select_from(only_visible(select(Document.id), auth).subquery()))
    finished, pages = db.execute(
        select(
            func.coalesce(func.sum(ReadingState.finished), 0),
            func.coalesce(func.sum(ReadingState.max_page), 0),
        ).where(ReadingState.user_id == auth.scope, ReadingState.document_id.in_(visible_ids))
    ).one()

    seconds_by_day = {
        day: seconds
        for day, seconds in db.execute(
            select(ReadingDay.date, ReadingDay.seconds).where(ReadingDay.user_id == auth.scope, ReadingDay.seconds > 0)
        )
    }
    today = utcnow().date()
    window = [today - timedelta(days=back) for back in range(STATS_DAYS - 1, -1, -1)]
    return Stats(
        documents=documents,
        finished=finished,
        pages_read=pages,
        seconds_read=round(sum(seconds_by_day.values())),
        daily_seconds=[
            DailySeconds(date=day.isoformat(), seconds=round(seconds_by_day.get(day.isoformat(), 0)))
            for day in window
        ],
        streak_days=_streak(set(seconds_by_day), today),
    )
