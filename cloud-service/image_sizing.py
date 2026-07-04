def get_resize_dimensions(width: int, height: int, max_side: int) -> tuple[int, int]:
    width = int(width or 0)
    height = int(height or 0)
    max_side = int(max_side or 0)
    if width <= 0 or height <= 0 or max_side <= 0:
        return width, height

    longest = max(width, height)
    if longest <= max_side:
        return width, height

    scale = max_side / float(longest)
    return max(1, round(width * scale)), max(1, round(height * scale))
