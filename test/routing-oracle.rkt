#lang racket/base
;; Development-only differential oracle for provider routing: the same scenarios
;; the portable engine resolves, resolved by the Racket implementation.
(require racket/list racket/runtime-path json provider)
(define-runtime-path scenarios-path "parity/routing-scenarios.json")

(define (sym v) (if (string? v) (string->symbol v) v))
(define (syms v) (for/list ([x (in-list v)]) (sym x)))
(define (opt h k [default #f]) (let ([v (hash-ref h k default)]) (if (eq? v 'null) default v)))

(define (scenario-capabilities caps)
  (provider-capabilities
   (syms (hash-ref caps 'modes '("structured")))
   (syms (hash-ref caps 'modalities '("text")))
   (syms (hash-ref caps 'permissions '("read")))
   (syms (hash-ref caps 'controls '("structured-output")))
   (hash-ref caps 'efforts '())
   (hash-ref caps 'max_parallel 1)))

(define (scenario-provider entry)
  (define id (string->symbol (hash-ref entry 'id)))
  (define state (hash-ref entry 'availability (hasheq 'status "ready")))
  (provider id (scenario-capabilities (hash-ref entry 'caps (hasheq)))
            (lambda () (availability (string->symbol (hash-ref state 'status))
                                     (opt state 'version)
                                     (sym (hash-ref state 'billing "unreported"))
                                     (opt state 'detail)))
            (lambda (request target) (error "the oracle never runs a provider"))))

(define (scenario-request entry)
  (define target (hash-ref entry 'target (hasheq)))
  (make-provider-request
   (string->symbol (hash-ref entry 'operation))
   (string->symbol (hash-ref entry 'mode))
   #:role (string->symbol (hash-ref entry 'role (hash-ref entry 'operation)))
   #:kind (let ([v (opt entry 'kind)]) (and v (string->symbol v)))
   #:tier (let ([v (opt entry 'tier)]) (and v (string->symbol v)))
   #:modalities (syms (hash-ref entry 'modalities '("text")))
   #:permissions (syms (hash-ref entry 'permissions '("read")))
   #:schema (opt entry 'schema)
   #:metadata (let ([m (hash-ref entry 'metadata (hasheq))])
                (if (hash-has-key? m 'disallowed) (hash-set m 'disallowed (hash-ref m 'disallowed)) m))
   #:target (target-spec (let ([v (opt target 'provider)]) (and v (string->symbol v)))
                         (opt target 'model)
                         (opt target 'effort)
                         (hash-ref target 'fallback '()))))

(define (target->jsexpr t)
  (hasheq 'provider (symbol->string (provider-id (resolved-target-provider t)))
          'model (or (resolved-target-model t) 'null)
          'requested_effort (or (resolved-target-requested-effort t) 'null)
          'effective_effort (or (resolved-target-effective-effort t) 'null)
          'sources (for/hasheq ([(k v) (in-hash (resolved-target-sources t))])
                     (values k (symbol->string v)))))

(define (rejection->jsexpr r)
  (hasheq 'provider (format "~a" (rejection-provider r))
          'kind (format "~a" (rejection-kind r))
          'detail (let ([d (rejection-detail r)]) (if (string? d) d 'null))))

(define (run scenario)
  (define registry (make-provider-registry))
  (for ([entry (in-list (hash-ref scenario 'providers))])
    (register-provider! registry (scenario-provider entry)))
  (define layers (hash-ref scenario 'layers (hasheq)))
  (define config
    (merge-provider-config
     #:defaults (hash-ref layers 'default (hasheq))
     #:user (hash-ref layers 'user (hasheq))
     #:project (hash-ref layers 'project (hasheq))
     #:package (hash-ref layers 'package (hasheq))
     #:environment (hash-ref layers 'environment (hasheq))
     #:request (hash-ref layers 'request (hasheq))
     #:role (let ([r (opt scenario 'role)]) (and r (string->symbol r)))))
  (define request (scenario-request (hash-ref scenario 'request)))
  ;; Excluded providers are named by id; resolve each one first to exclude it.
  (define excluded
    (for/list ([id (in-list (hash-ref scenario 'exclude '()))])
      (resolved-target (registry-provider registry (string->symbol id)) #f #f #f (hasheq))))
  (with-handlers ([exn:fail:provider?
                   (lambda (e)
                     (hasheq 'name (hash-ref scenario 'name)
                             'error (hasheq 'kind (format "~a" (exn:fail:provider-kind e))
                                            'message (exn-message e)
                                            'rejections
                                            (let ([d (exn:fail:provider-detail e)])
                                              (if (list? d) (map rejection->jsexpr d) '())))))])
    (define result (resolve-provider request config registry #:exclude excluded))
    (hasheq 'name (hash-ref scenario 'name)
            'target (target->jsexpr (resolution-target result))
            'rejections (map rejection->jsexpr (resolution-rejections result))
            'matched_route (or (resolution-matched-route result) 'null))))

(write-json
 (for/list ([scenario (in-list (call-with-input-file scenarios-path read-json))])
   (run scenario)))
