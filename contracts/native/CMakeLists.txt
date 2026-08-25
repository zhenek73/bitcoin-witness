cmake_minimum_required(VERSION 3.16)
project(btcwitness)

find_package(cdt)

add_contract(btcwitness btcwitness
    src/btcwitness.cpp
)

target_include_directories(btcwitness PUBLIC include)
target_compile_options(btcwitness PUBLIC --no-missing-ricardian-clause)
