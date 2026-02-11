fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Tell Cargo to rerun if proto changes
    println!("cargo:rerun-if-changed=../../proto/openllm/v1/service.proto");

    // Compile the proto file
    tonic_build::configure()
        .build_server(true)
        .build_client(true) // Also build client for testing
        .out_dir("src/proto")
        .compile_protos(
            &["../../proto/openllm/v1/service.proto"],
            &["../../proto"],
        )?;

    Ok(())
}
