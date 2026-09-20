#lang racket/base
;; Development-only differential oracle for importing an MCP tool list as action
;; declarations, and for the drift report against a live server.
(require racket/list racket/runtime-path racket/string json jev/mcp-import)
(define-runtime-path cases-path "parity/mcp-import-cases.json")
(define cases (call-with-input-file cases-path read-json))

;; The (action ...) form, normalized to JSON so the portable declarations can be
;; compared with it.
(define (form->jsexpr form)
  (let loop ([items (cddr form)] [params '()] [flags (hasheq)])
    (cond
      [(null? items)
       (hasheq 'name (symbol->string (cadr form)) 'params (reverse params) 'flags flags)]
      [(memq (car items) '(#:doc #:min-confidence #:cooldown #:timeout))
       (loop (cddr items) params (hash-set flags (string->symbol (keyword->string (car items)))
                                          (let ([v (cadr items)]) (if (string? v) v v))))]
      [(eq? (car items) '#:allow)
       (loop (cddr items) params (hash-set flags 'allow (map symbol->string (cadr items))))]
      [(eq? (car items) '#:undo)
       (define u (cadr items))
       (loop (cddr items) params
             (hash-set flags 'undo
                       (hasheq 'target (symbol->string (car u))
                               'args (let pairs ([xs (cdr u)] [acc (hasheq)])
                                       (if (null? xs) acc
                                           (pairs (cddr xs)
                                                  (hash-set acc (string->symbol (keyword->string (car xs)))
                                                            (let ([v (cadr xs)])
                                                              (if (symbol? v) (list "param" (symbol->string v)) (list "value" v))))))))))]
      [(keyword? (car items))
       (loop (cdr items) params (hash-set flags (string->symbol (keyword->string (car items))) #t))]
      [else
       (define p (car items))
       (loop (cdr items)
             (cons (hasheq 'name (symbol->string (car p))
                           'type (format "~s" (cadr p))
                           'rest (map (lambda (x) (format "~s" x)) (cddr p)))
                   params)
             flags)])))

(write-json
 (hasheq 'imported
         (for/list ([tool (in-list (hash-ref cases 'tools))])
           (define-values (form warning) (tool->action-form tool))
           (if form
               (hasheq 'action (form->jsexpr form) 'warning 'null)
               (hasheq 'action 'null 'warning warning)))
         'confirm (for/list ([tool (in-list (hash-ref cases 'tools))]) (tool-confirm? tool))
         'drift
         (for/list ([pair (in-list (hash-ref cases 'drift))])
           (define-values (drift notes) (snapshot-drift (first pair) (second pair)))
           (hasheq 'drift drift 'notes notes))))
