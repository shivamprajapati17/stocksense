import { dispatch } from '@/lib/api';
import type { NextRequest } from 'next/server';

export const runtime = 'nodejs';
export const GET = (request: NextRequest) => dispatch(request);
export const POST = (request: NextRequest) => dispatch(request);
export const PUT = (request: NextRequest) => dispatch(request);
export const PATCH = (request: NextRequest) => dispatch(request);
export const DELETE = (request: NextRequest) => dispatch(request);
