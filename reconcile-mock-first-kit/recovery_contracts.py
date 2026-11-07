"""Documented Adapty request shapes, exercised locally with synthetic references.

Sources (checked 2026-11-07):
https://adapty.io/docs/api-adapty/operations/validateStripePurchase
https://adapty.io/docs/api-adapty/operations/validatePaddlePurchase
This module performs no network requests and holds no provider credentials.
"""
import hashlib


CONTRACTS = {
    'stripe': ('/api/v1/sdk/purchase/stripe/token/validate/', 'application/vnd.api+json'),
    'paddle': ('/api/v2/server-side-api/purchase/paddle/token/validate/', 'application/json'),
}


def _text(value):
    if (not isinstance(value, str) or not value or value != value.strip()
            or len(value) > 256 or any(ord(c) < 32 for c in value)):
        raise ValueError('Invalid validation reference')
    return value


def validation_request(provider, user_id, transaction_id):
    if provider not in CONTRACTS:
        raise ValueError('No Stripe/Paddle validation contract for this provider')
    user_id, transaction_id = _text(user_id), _text(transaction_id)
    suffix = hashlib.sha256(transaction_id.encode()).hexdigest()
    reference = ('sub_mock_' if provider == 'stripe' else 'txn_mock_') + suffix
    if provider == 'stripe':
        body = {'data': {'type': 'stripe_receipt_validation_result',
                         'attributes': {'customer_user_id': user_id, 'stripe_token': reference}}}
    else:
        body = {'customer_user_id': user_id, 'paddle_token': reference}
    path, content_type = CONTRACTS[provider]
    return {'method': 'POST', 'path': path, 'content_type': content_type, 'body': body}


def validate_request(provider, request):
    """Reject a provider's other wire shape before a simulator changes its profile."""
    if provider not in CONTRACTS or not isinstance(request, dict):
        raise ValueError('Unsupported validation contract')
    path, content_type = CONTRACTS[provider]
    if (set(request) != {'method', 'path', 'content_type', 'body'}
            or request['method'] != 'POST' or request['path'] != path
            or request['content_type'] != content_type):
        raise ValueError('Validation transport contract mismatch')
    body = request['body']
    if provider == 'stripe':
        if (not isinstance(body, dict) or set(body) != {'data'}
                or not isinstance(body['data'], dict) or set(body['data']) != {'type', 'attributes'}
                or body['data']['type'] != 'stripe_receipt_validation_result'):
            raise ValueError('Invalid Stripe validation body')
        attributes, token_field = body['data']['attributes'], 'stripe_token'
    else:
        attributes, token_field = body, 'paddle_token'
    if not isinstance(attributes, dict) or set(attributes) != {'customer_user_id', token_field}:
        raise ValueError('Invalid provider validation attributes')
    user = _text(attributes['customer_user_id'])
    reference = _text(attributes[token_field])
    prefixes = ('sub_', 'pi_') if provider == 'stripe' else ('txn_', 'sub_')
    if not reference.startswith(prefixes):
        raise ValueError('Unsupported provider purchase reference')
    return {'customer_user_id': user, 'purchase_reference': reference}
