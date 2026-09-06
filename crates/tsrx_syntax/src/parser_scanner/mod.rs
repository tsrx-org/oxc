//! The byte-level structural scan that locates TSRX syntax in an authored source without parsing
//! it.

mod control;
mod dynamic;
mod header;
mod jsx;
mod lexical;
mod overlay;
mod region;
mod stack;
mod state;
mod surrogates;

pub use surrogates::OpaqueSurrogateContext;

pub(crate) use state::{Scanner, admits_line_leading_markup};
