from pathlib import Path

from recit_media_ai.images import failure_message

LOG = Path("last-error.log")


def test_reports_the_first_real_error_not_the_generic_last_line() -> None:
    errors = [
        "[E] LLM prompt encoding failed",
        "[E] generate failed: line 47, column 21: prompt encoding failed --- main.cpp:815",
    ]
    message = failure_message(errors, errors, 1, LOG)
    assert "LLM prompt encoding failed" in message
    assert "line 47" not in message
    assert "last-error.log" in message


def test_out_of_memory_is_said_plainly() -> None:
    errors = [
        "[E] ggml_backend_cuda_buffer_type_alloc_buffer: allocating 2100 MiB on device 0: "
        "cudaMalloc failed: out of memory",
        "[E] generate failed: prompt encoding failed",
    ]
    message = failure_message(errors, errors, 1, LOG)
    assert message.startswith("The graphics card ran out of memory")


def test_falls_back_to_the_last_line_or_exit_code() -> None:
    assert "something odd" in failure_message([], ["", "something odd", ""], 3, LOG)
    assert "exit code 3" in failure_message([], [], 3, LOG)


def test_running_out_of_system_ram_is_said_plainly() -> None:
    errors = [
        "[E] RAM weight capacity exceeded. Requested 0 bytes, 0 bytes available, "
        "3683325184 bytes resident --- model_manager.cpp:1359",
        "[E] generate failed: line 59, column 14: diffusion output shape [] --- main.cpp:815",
    ]
    assert failure_message(errors, errors, 1, LOG).startswith("Your PC ran out of memory (RAM)")
