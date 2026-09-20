#lang racket/base
;; Development-only differential oracle for webhooks: the signature this engine
;; writes, and every verifier's answer on the same headers and body.
(require racket/list racket/runtime-path json jev/webhooks)
(define-runtime-path cases-path "parity/webhook-cases.json")
(define cases (call-with-input-file cases-path read-json))
(define secret (hash-ref cases 'secret))
(define body (string->bytes/utf-8 (hash-ref cases 'body)))
(define now (hash-ref cases 'now))

(define (headers-of entry)
  (for/list ([(k v) (in-hash (hash-ref entry 'headers))]) (cons (symbol->string k) v)))

(define (check v entry)
  (define-values (ok? id reason) (v (headers-of entry) body now))
  (hasheq 'ok (and ok? #t) 'id (or id 'null) 'reason (or reason 'null)))

(define (opt v) (if (eq? v 'null) #f v))

(write-json
 (hasheq
  'sign (for/list ([pair (in-list (hash-ref cases 'sign))])
          (standard-webhooks-sign secret (first pair) (second pair) body))
  'keys (for/list ([s (in-list (hash-ref cases 'keys))])
          (define k (with-handlers ([exn:fail? (lambda (_) #f)]) (standard-webhooks-key s)))
          (if k (bytes->list k) 'null))
  'standard (for/list ([e (in-list (hash-ref cases 'standard))])
              (check (standard-webhooks-verifier secret) e))
  'github (for/list ([e (in-list (hash-ref cases 'github))])
            (check (github-verifier "gh-secret") e))
  'stripe (for/list ([e (in-list (hash-ref cases 'stripe))])
            (check (stripe-verifier "stripe-secret") e))
  'slack (for/list ([e (in-list (hash-ref cases 'slack))])
           (check (slack-verifier "slack-secret") e))
  'hmac (for/list ([e (in-list (hash-ref cases 'hmac))])
          (check (hmac-verifier "plain-secret"
                                #:header "x-signature"
                                #:encoding (string->symbol (hash-ref e 'encoding))
                                #:prefix (hash-ref e 'prefix)
                                #:id-header (opt (hash-ref e 'idHeader)))
                 e))
  'missing-secret (let-values ([(ok? id reason) ((standard-webhooks-verifier (env-secret "JEV_NO_SUCH_SECRET"))
                                                 (list) body now)])
                    (hasheq 'ok (and ok? #t) 'reason (or reason 'null)))
  'problems (list (or (verifier-problem (standard-webhooks-verifier (env-secret "JEV_NO_SUCH_SECRET"))) 'null)
                  (or (verifier-problem (standard-webhooks-verifier "whsec_not!base64")) 'null)
                  (or (verifier-problem (github-verifier "gh-secret")) 'null))))
