---
name: golang-patterns
description: Go idioms — accept-interfaces/return-structs, error wrapping with %w and errors.Is/As, goroutines/channels/errgroup, context cancellation, functional options, go vet/staticcheck. Language layer over the clean-code floor.
metadata:
  source: everything-claude-code
  source_path: skills/golang-patterns/SKILL.md
  source_commit: 4e66b2882da9afb9747468b08a253ca2f09c85f3
  adapted_for: traffic-one
---

# Go Development Patterns

Generic naming, immutability, KISS/DRY/YAGNI, file/function size, and code-smell rules live in the always-on `rules/common/clean-code.md` — do not restate them. This skill keeps only the Go-specific idioms below.

Apply when writing, reviewing, or refactoring Go code or designing packages/modules.

## Core Idioms

### Make the Zero Value Useful

Design types so their zero value is immediately usable without initialization.

```go
// Good: Zero value is useful
type Counter struct {
    mu    sync.Mutex
    count int // zero value is 0, ready to use
}

func (c *Counter) Inc() {
    c.mu.Lock()
    c.count++
    c.mu.Unlock()
}

// Good: bytes.Buffer works with zero value
var buf bytes.Buffer
buf.WriteString("hello")

// Bad: Requires initialization
type BadCounter struct {
    counts map[string]int // nil map will panic
}
```

### Accept Interfaces, Return Structs

Functions should accept interface parameters and return concrete types.

```go
// Good: Accepts interface, returns concrete type
func ProcessData(r io.Reader) (*Result, error) {
    data, err := io.ReadAll(r)
    if err != nil {
        return nil, err
    }
    return &Result{Data: data}, nil
}

// Bad: Returns interface (hides implementation details unnecessarily)
func ProcessData(r io.Reader) (io.Reader, error) {
    // ...
}
```

## Error Handling Patterns

### Error Wrapping with Context

```go
// Good: Wrap errors with context
func LoadConfig(path string) (*Config, error) {
    data, err := os.ReadFile(path)
    if err != nil {
        return nil, fmt.Errorf("load config %s: %w", path, err)
    }

    var cfg Config
    if err := json.Unmarshal(data, &cfg); err != nil {
        return nil, fmt.Errorf("parse config %s: %w", path, err)
    }

    return &cfg, nil
}
```

### Custom Error Types

```go
// Define domain-specific errors
type ValidationError struct {
    Field   string
    Message string
}

func (e *ValidationError) Error() string {
    return fmt.Sprintf("validation failed on %s: %s", e.Field, e.Message)
}

// Sentinel errors for common cases
var (
    ErrNotFound     = errors.New("resource not found")
    ErrUnauthorized = errors.New("unauthorized")
    ErrInvalidInput = errors.New("invalid input")
)
```

### Error Checking with errors.Is and errors.As

```go
func HandleError(err error) {
    // Check for specific error
    if errors.Is(err, sql.ErrNoRows) {
        log.Println("No records found")
        return
    }

    // Check for error type
    var validationErr *ValidationError
    if errors.As(err, &validationErr) {
        log.Printf("Validation error on field %s: %s",
            validationErr.Field, validationErr.Message)
        return
    }

    // Unknown error
    log.Printf("Unexpected error: %v", err)
}
```

### Never Ignore Errors

```go
// Bad: Ignoring error with blank identifier
result, _ := doSomething()

// Good: Handle or explicitly document why it's safe to ignore
result, err := doSomething()
if err != nil {
    return err
}

// Acceptable: When error truly doesn't matter (rare)
_ = writer.Close() // Best-effort cleanup, error logged elsewhere
```

## Concurrency Patterns

### Worker Pool

```go
func WorkerPool(jobs <-chan Job, results chan<- Result, numWorkers int) {
    var wg sync.WaitGroup

    for i := 0; i < numWorkers; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            for job := range jobs {
                results <- process(job)
            }
        }()
    }

    wg.Wait()
    close(results)
}
```

### Context for Cancellation and Timeouts

```go
func FetchWithTimeout(ctx context.Context, url string) ([]byte, error) {
    ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
    defer cancel()

    req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
    if err != nil {
        return nil, fmt.Errorf("create request: %w", err)
    }

    resp, err := http.DefaultClient.Do(req)
    if err != nil {
        return nil, fmt.Errorf("fetch %s: %w", url, err)
    }
    defer resp.Body.Close()

    return io.ReadAll(resp.Body)
}
```

### Graceful Shutdown

```go
func GracefulShutdown(server *http.Server) {
    quit := make(chan os.Signal, 1)
    signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)

    <-quit
    log.Println("Shutting down server...")

    ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()

    if err := server.Shutdown(ctx); err != nil {
        log.Fatalf("Server forced to shutdown: %v", err)
    }

    log.Println("Server exited")
}
```

### errgroup for Coordinated Goroutines

```go
import "golang.org/x/sync/errgroup"

func FetchAll(ctx context.Context, urls []string) ([][]byte, error) {
    g, ctx := errgroup.WithContext(ctx)
    results := make([][]byte, len(urls))

    for i, url := range urls {
        i, url := i, url // Capture loop variables
        g.Go(func() error {
            data, err := FetchWithTimeout(ctx, url)
            if err != nil {
                return err
            }
            results[i] = data
            return nil
        })
    }

    if err := g.Wait(); err != nil {
        return nil, err
    }
    return results, nil
}
```

### Avoiding Goroutine Leaks

```go
// Bad: Goroutine leak if context is cancelled
func leakyFetch(ctx context.Context, url string) <-chan []byte {
    ch := make(chan []byte)
    go func() {
        data, _ := fetch(url)
        ch <- data // Blocks forever if no receiver
    }()
    return ch
}

// Good: Properly handles cancellation
func safeFetch(ctx context.Context, url string) <-chan []byte {
    ch := make(chan []byte, 1) // Buffered channel
    go func() {
        data, err := fetch(url)
        if err != nil {
            return
        }
        select {
        case ch <- data:
        case <-ctx.Done():
        }
    }()
    return ch
}
```

## Interface Design

### Small, Focused Interfaces

```go
// Good: Single-method interfaces
type Reader interface {
    Read(p []byte) (n int, err error)
}

type Writer interface {
    Write(p []byte) (n int, err error)
}

type Closer interface {
    Close() error
}

// Compose interfaces as needed
type ReadWriteCloser interface {
    Reader
    Writer
    Closer
}
```

### Define Interfaces Where They're Used

```go
// In the consumer package, not the provider
package service

// UserStore defines what this service needs
type UserStore interface {
    GetUser(id string) (*User, error)
    SaveUser(user *User) error
}

type Service struct {
    store UserStore
}

// Concrete implementation can be in another package
// It doesn't need to know about this interface
```

### Optional Behavior with Type Assertions

```go
type Flusher interface {
    Flush() error
}

func WriteAndFlush(w io.Writer, data []byte) error {
    if _, err := w.Write(data); err != nil {
        return err
    }

    // Flush if supported
    if f, ok := w.(Flusher); ok {
        return f.Flush()
    }
    return nil
}
```

## Package Organization

### Standard Project Layout

**On a Traffic One-compiled project the runtime owns the layout — do not apply
this section there.** Your writable paths are exactly the compiled outputs in
your work unit; a write anywhere else is denied with
`STRUCT_ASSIGNMENT_ALLOWLIST_GAP`, and the deny tells you not to retry it or
relocate it. Read your allowlist first and write the module where the contract
put it. The layout below is the community convention, for reading and extending
a repo Traffic One did not compile (`existing-codebase` mode).

```text
myproject/
├── cmd/
│   └── myapp/
│       └── main.go           # Entry point
├── internal/
│   ├── handler/              # HTTP handlers
│   ├── service/              # Business logic
│   ├── repository/           # Data access
│   └── config/               # Configuration
├── pkg/
│   └── client/               # Public API client
├── api/
│   └── v1/                   # API definitions (proto, OpenAPI)
├── testdata/                 # Test fixtures
├── go.mod
├── go.sum
└── Makefile
```

### Package Naming

```go
// Good: Short, lowercase, no underscores
package http
package json
package user

// Bad: Verbose, mixed case, or redundant
package httpHandler
package json_parser
package userService // Redundant 'Service' suffix
```

### Avoid Package-Level State

```go
// Bad: Global mutable state
var db *sql.DB

func init() {
    db, _ = sql.Open("postgres", os.Getenv("DATABASE_URL"))
}

// Good: Dependency injection
type Server struct {
    db *sql.DB
}

func NewServer(db *sql.DB) *Server {
    return &Server{db: db}
}
```

## Struct Design

### Functional Options Pattern

```go
type Server struct {
    addr    string
    timeout time.Duration
    logger  *log.Logger
}

type Option func(*Server)

func WithTimeout(d time.Duration) Option {
    return func(s *Server) {
        s.timeout = d
    }
}

func WithLogger(l *log.Logger) Option {
    return func(s *Server) {
        s.logger = l
    }
}

func NewServer(addr string, opts ...Option) *Server {
    s := &Server{
        addr:    addr,
        timeout: 30 * time.Second, // default
        logger:  log.Default(),    // default
    }
    for _, opt := range opts {
        opt(s)
    }
    return s
}

// Usage
server := NewServer(":8080",
    WithTimeout(60*time.Second),
    WithLogger(customLogger),
)
```

### Embedding for Composition

```go
type Logger struct {
    prefix string
}

func (l *Logger) Log(msg string) {
    fmt.Printf("[%s] %s\n", l.prefix, msg)
}

type Server struct {
    *Logger // Embedding - Server gets Log method
    addr    string
}

func NewServer(addr string) *Server {
    return &Server{
        Logger: &Logger{prefix: "SERVER"},
        addr:   addr,
    }
}

// Usage
s := NewServer(":8080")
s.Log("Starting...") // Calls embedded Logger.Log
```

## Memory and Performance

### Preallocate Slices When Size is Known

```go
// Bad: Grows slice multiple times
func processItems(items []Item) []Result {
    var results []Result
    for _, item := range items {
        results = append(results, process(item))
    }
    return results
}

// Good: Single allocation
func processItems(items []Item) []Result {
    results := make([]Result, 0, len(items))
    for _, item := range items {
        results = append(results, process(item))
    }
    return results
}
```

### Use sync.Pool for Frequent Allocations

```go
var bufferPool = sync.Pool{
    New: func() interface{} {
        return new(bytes.Buffer)
    },
}

func ProcessRequest(data []byte) []byte {
    buf := bufferPool.Get().(*bytes.Buffer)
    defer func() {
        buf.Reset()
        bufferPool.Put(buf)
    }()

    buf.Write(data)
    // Process...
    return buf.Bytes()
}
```

### String Building

```go
// strings.Builder for incremental builds; strings.Join for the simple case
var sb strings.Builder
for i, p := range parts {
    if i > 0 {
        sb.WriteString(",")
    }
    sb.WriteString(p)
}
result := sb.String()

result := strings.Join(parts, ",")
```

## Go Tooling Integration

### Essential Commands

```bash
# Compile-check everything. The `-o` sink is not optional: bare `go build ./...`
# writes a binary named after the package directory whenever the pattern matches
# exactly one `main` package, and on a Traffic One compiled layout that name is
# the directory itself — `build output "internal" already exists and is a
# directory`, exit 1, with nothing wrong in the code. Verified twice: the QA
# runner hit it in 15cl, and 18cl's reviewer re-derived it from an ADR that had
# copied the bare form. `-o /dev/null` is Go's own compile-check idiom (on
# Windows: `-o NUL`) — the object is discarded and no file lands in the tree.
go build -o /dev/null ./...
go run ./cmd/myapp

# Testing
go test ./...
go test -race ./...
go test -cover ./...

# Static analysis
go vet ./...
staticcheck ./...
golangci-lint run

# Module management
go mod tidy
go mod verify

# Formatting
gofmt -w .
goimports -w .
```

### Recommended Linter Configuration (.golangci.yml)

Schema **v2**. Settings live under `linters.settings`; the v1 top-level
`linters-settings` key makes v2 refuse to run at all (`additional properties
'linters-settings' not allowed`), so a config carrying it disables the linter
rather than loosening it. `gosimple` merged into `staticcheck` and
`govet.check-shadowing` was removed in v2. Traffic One seeds a smaller version of
this file on Go projects — edit it, do not fight it.

```yaml
version: "2"
linters:
  enable:
    - errcheck
    - govet
    - ineffassign
    - staticcheck
    - unused
    - misspell
    - unconvert
    - unparam
  settings:
    errcheck:
      check-type-assertions: true
formatters:
  enable:
    - gofmt
    - goimports
```

## Quick Reference: Go Idioms

| Idiom | Description |
|-------|-------------|
| Accept interfaces, return structs | Functions accept interface params, return concrete types |
| Errors are values | Treat errors as first-class values, not exceptions |
| Don't communicate by sharing memory | Use channels for coordination between goroutines |
| Make the zero value useful | Types should work without explicit initialization |
| A little copying is better than a little dependency | Avoid unnecessary external dependencies |
| Clear is better than clever | Prioritize readability over cleverness |
| gofmt is no one's favorite but everyone's friend | Always format with gofmt/goimports |
| Return early | Handle errors first, keep happy path unindented |

## Anti-Patterns to Avoid

```go
// Bad: Naked returns in long functions
func process() (result int, err error) {
    // ... 50 lines ...
    return // What is being returned?
}

// Bad: Using panic for control flow
func GetUser(id string) *User {
    user, err := db.Find(id)
    if err != nil {
        panic(err) // Don't do this
    }
    return user
}

// Bad: Passing context in struct
type Request struct {
    ctx context.Context // Context should be first param
    ID  string
}

// Good: Context as first parameter
func ProcessRequest(ctx context.Context, id string) error {
    // ...
}

// Bad: Mixing value and pointer receivers
type Counter struct{ n int }
func (c Counter) Value() int { return c.n }    // Value receiver
func (c *Counter) Increment() { c.n++ }        // Pointer receiver
// Pick one style and be consistent
```
