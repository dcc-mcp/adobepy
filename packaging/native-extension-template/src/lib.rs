use pyo3::prelude::*;

#[pymodule]
fn _native(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add("__abi3_floor__", "cp38-abi3")?;
    Ok(())
}
