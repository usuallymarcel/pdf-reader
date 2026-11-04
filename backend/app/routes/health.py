from fastapi import APIRouter

router = APIRouter(prefix='/api', tags=['health'])


@router.get('/healthz')
def healthz():
    return {'status': 'ok'}
