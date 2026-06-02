"""Plan 07 Task 12 — OpenTelemetry tracing helper for the Python engine.

Mirrors ``packages/shared/src/tracing.ts``. The module is safe to
import even when the OTel SDK is not installed: ``init_otel`` returns
a no-op handle, and ``get_tracer`` returns a no-op tracer that yields
``None`` from ``start_as_current_span``.

Usage::

    from calderyn_engine.tracing import init_otel, get_tracer

    handle = init_otel("calderyn-engine")
    tracer = get_tracer(__name__)

    async def run_for_shop(shop_id, ...):
        with tracer.start_as_current_span("engine.run_for_shop") as span:
            if span is not None:
                span.set_attribute("shop_id", shop_id)
            ...

The instrumented spans live at the boundary points identified in Plan
07 Task 12: ``pipeline.run_for_shop``, the action gateway's
``executeAction``, and every executor.
"""
from __future__ import annotations

import contextlib
import os
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any, Protocol


class _SpanLike(Protocol):
    """Subset of the OTel ``Span`` API that callers may rely on."""

    def set_attribute(self, key: str, value: Any) -> None: ...

    def record_exception(self, exc: BaseException) -> None: ...


class _TracerLike(Protocol):
    @contextlib.contextmanager
    def start_as_current_span(
        self, name: str, **kwargs: Any
    ) -> Iterator[_SpanLike | None]: ...


@dataclass(frozen=True)
class OtelHandle:
    """Returned from :func:`init_otel`. ``enabled`` reflects whether
    an exporter was actually wired; callers can branch on it for
    optional bookkeeping (e.g. logging tracer ids on alert rows)."""

    service_name: str
    enabled: bool

    def shutdown(self) -> None:  # noqa: D401 — explicit verb
        """Flush + shutdown the SDK. No-op when ``enabled`` is False.

        We resolve and call the SDK shutdown lazily so importing this
        module does not require the OTel SDK to be installed.
        """
        if not self.enabled:
            return
        try:
            from opentelemetry.sdk.trace import (  # type: ignore[import-not-found]
                TracerProvider,
            )

            provider = _provider_singleton()
            if isinstance(provider, TracerProvider):
                provider.shutdown()
        except Exception:  # noqa: BLE001 — observability must not crash callers
            pass


_PROVIDER: Any | None = None


def _provider_singleton() -> Any | None:
    return _PROVIDER


def init_otel(service_name: str, *, service_version: str = "0.0.1") -> OtelHandle:
    """Set up an OTLP exporter when ``OTEL_EXPORTER_OTLP_ENDPOINT`` is
    set, otherwise return a no-op handle.

    The function is idempotent: calling it twice returns the same
    handle and does not re-register a provider.
    """

    global _PROVIDER

    endpoint = os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT")
    if not endpoint:
        return OtelHandle(service_name=service_name, enabled=False)

    if _PROVIDER is not None:
        return OtelHandle(service_name=service_name, enabled=True)

    try:
        from opentelemetry import trace  # type: ignore[import-not-found]
        from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import (  # type: ignore[import-not-found]
            OTLPSpanExporter,
        )
        from opentelemetry.sdk.resources import Resource  # type: ignore[import-not-found]
        from opentelemetry.sdk.trace import TracerProvider  # type: ignore[import-not-found]
        from opentelemetry.sdk.trace.export import (  # type: ignore[import-not-found]
            BatchSpanProcessor,
        )

        resource = Resource.create(
            {
                "service.name": service_name,
                "service.version": service_version,
            }
        )
        provider = TracerProvider(resource=resource)
        provider.add_span_processor(
            BatchSpanProcessor(OTLPSpanExporter(endpoint=endpoint))
        )
        trace.set_tracer_provider(provider)
        _PROVIDER = provider
        return OtelHandle(service_name=service_name, enabled=True)
    except Exception:  # noqa: BLE001 — never crash on missing optional dep
        return OtelHandle(service_name=service_name, enabled=False)


class _NoopSpan:
    def set_attribute(self, key: str, value: Any) -> None:  # noqa: D401
        return None

    def record_exception(self, exc: BaseException) -> None:  # noqa: D401
        return None


class _NoopTracer:
    @contextlib.contextmanager
    def start_as_current_span(
        self, name: str, **kwargs: Any
    ) -> Iterator[_NoopSpan]:
        del name, kwargs
        yield _NoopSpan()


def get_tracer(name: str) -> _TracerLike:
    """Return an OTel tracer when available; fall back to a no-op."""

    try:
        from opentelemetry import trace  # type: ignore[import-not-found]

        return trace.get_tracer(name)
    except Exception:  # noqa: BLE001
        return _NoopTracer()  # type: ignore[return-value]
