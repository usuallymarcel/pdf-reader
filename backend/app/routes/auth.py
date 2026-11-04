from fastapi import APIRouter, Depends, HTTPException, Request, Response

from app.auth import COOKIE_MAX_AGE, COOKIE_NAME, AuthContext, UsersApiDown, get_auth, session_payload
from app.schemas import Credentials, Session, Signup

router = APIRouter(prefix='/api', tags=['auth'])


def enforce_rate_limit(request: Request, name: str) -> None:
    limiter = request.app.state.login_limiter
    client = request.client.host if request.client else 'unknown'
    wait = max(limiter.retry_after(f'ip:{client}'), limiter.retry_after(f'name:{name.strip().lower()}'))
    if wait:
        raise HTTPException(429, 'Too many attempts. Try again in a minute.', headers={'Retry-After': str(int(wait) + 1)})


def require_login_service(auth: AuthContext) -> None:
    if auth.auth_status != 'ok':
        raise HTTPException(503, 'The login service is unavailable.')


def set_session_cookie(request: Request, response: Response, token: str) -> None:
    response.set_cookie(
        COOKIE_NAME,
        token,
        max_age=COOKIE_MAX_AGE,
        path='/',
        httponly=True,
        samesite='lax',
        secure=request.url.scheme == 'https',
    )


@router.get('/session')
def session(request: Request, auth: AuthContext = Depends(get_auth)) -> Session:
    return session_payload(request, auth)


@router.post('/auth/login')
async def login(data: Credentials, request: Request, response: Response, auth: AuthContext = Depends(get_auth)) -> Session:
    require_login_service(auth)
    enforce_rate_limit(request, data.name)
    try:
        result = await request.app.state.auth.login(data.name, data.password)
    except UsersApiDown:
        raise HTTPException(503, 'The login service is unavailable.') from None
    if result is None:
        raise HTTPException(401, 'Incorrect name or password.')
    token, user = result
    set_session_cookie(request, response, token)
    return session_payload(request, AuthContext('scoped', 'ok', user))


@router.post('/auth/signup')
async def signup(data: Signup, request: Request, response: Response, auth: AuthContext = Depends(get_auth)) -> Session:
    if not request.app.state.settings.allow_signup:
        raise HTTPException(403, 'Sign-up is disabled.')
    require_login_service(auth)
    enforce_rate_limit(request, data.name)
    try:
        result = await request.app.state.auth.signup(data.name, data.password)
    except UsersApiDown:
        raise HTTPException(503, 'The login service is unavailable.') from None
    if result is None:
        raise HTTPException(409, 'That name is already taken.')
    token, user = result
    set_session_cookie(request, response, token)
    return session_payload(request, AuthContext('scoped', 'ok', user))


@router.post('/auth/logout')
async def logout(request: Request, response: Response, auth: AuthContext = Depends(get_auth)) -> Session:
    token = request.cookies.get(COOKIE_NAME)
    if token:
        await request.app.state.auth.logout(token)
    response.delete_cookie(
        COOKIE_NAME,
        path='/',
        httponly=True,
        samesite='lax',
        secure=request.url.scheme == 'https',
    )
    return session_payload(request, AuthContext(auth.mode, auth.auth_status))
