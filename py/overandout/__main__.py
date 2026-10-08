"""`python -m overandout` prints the instructions an agent should follow."""

from .instructions import INSTRUCTIONS

if __name__ == "__main__":
    print(INSTRUCTIONS, end="")
